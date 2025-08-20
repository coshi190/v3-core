const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const envPath = path.resolve(process.cwd(), '../.env');

if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
    if (result.error) {
        console.error('Error loading .env file:', result.error);
        process.exit(1);
    }
    console.log(`Loaded ${Object.keys(result.parsed || {}).length} environment variables from .env`);
} else {
    console.error('.env file not found. Please copy .env.example to .env and configure it.');
    console.log('Run: cp .env.example .env');
    process.exit(1);
}

const config = {
    rpcUrl: process.env.RPC_URL,    
    privateKey: process.env.PRIVATE_KEY,    
    factoryAddress: process.env.FACTORY_ADDRESS,
    factoryDeploymentblock: process.env.FACTORY_DEPLOYMENT_BLOCKS,  
    feeProtocol0: parseInt(process.env.FEE_PROTOCOL_0) || 10,
    feeProtocol1: parseInt(process.env.FEE_PROTOCOL_1) || 10,    
    batchSize: parseInt(process.env.BATCH_SIZE) || 50,    
    gasLimit: parseInt(process.env.GAS_LIMIT) || 100000,
    maxFeePerGas: ethers.utils.parseUnits(process.env.MAX_FEE_PER_GAS || '30', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits(process.env.MAX_PRIORITY_FEE_PER_GAS || '2', 'gwei'),    
    networkName: process.env.NETWORK_NAME,    
    outputDir: process.env.OUTPUT_DIR || './fee-enable-reports',
};

const factoryABI = [
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
];

const poolABI = [
    'function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)'
];

class UniswapV3FeeProtocolUpdater {
    constructor(config) {
        this.config = config;
        this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        this.wallet = new ethers.Wallet(config.privateKey, this.provider);
        this.factory = new ethers.Contract(config.factoryAddress, factoryABI, this.wallet);
        
        this.successCount = 0;
        this.errorCount = 0;
        this.errors = [];
        this.processedPools = [];
        this.skippedPools = [];
        this.startTime = null;
        this.endTime = null;
    }

    async generateReport(allPools, poolsNeedingUpdate) {
        this.endTime = new Date();
        const duration = this.endTime - this.startTime;
        
        const reportDir = path.join(this.config.outputDir, `report`);
        
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        
        console.log(`\nGenerating reports in: ${reportDir}`);
        
        await this.generateSummaryReport(reportDir, allPools, poolsNeedingUpdate, duration);                
        await this.generateJSONReport(reportDir, allPools, poolsNeedingUpdate, duration);
        
        console.log(`Reports generated successfully!`);
    }

    async generateSummaryReport(reportDir, allPools, poolsNeedingUpdate, duration) {
        const summaryFile = path.join(reportDir, 'summary.txt');
        
        const totalGasUsed = this.processedPools
            .filter(p => p.gasUsed)
            .reduce((sum, p) => sum + BigInt(p.gasUsed), BigInt(0));
            
        const averageGasPrice = this.processedPools
            .filter(p => p.effectiveGasPrice)
            .reduce((sum, p, _, arr) => sum + BigInt(p.effectiveGasPrice) / BigInt(arr.length), BigInt(0));
            
        const totalCost = totalGasUsed * averageGasPrice;
        
        const summary = `
        ═══════════════════════════════════════════════════════════════
                            UNISWAP V3 FEE PROTOCOL UPDATE REPORT
        ═══════════════════════════════════════════════════════════════

        EXECUTION SUMMARY
        ────────────────────────────────────────────────────────────────
        Network:                    ${this.config.networkName}
        Factory Address:             ${this.config.factoryAddress}
        Executor Address:            ${this.wallet.address}
        Target Fee Protocol:         ${this.config.feeProtocol0}/${this.config.feeProtocol1}

        TIMING INFORMATION
        ────────────────────────────────────────────────────────────────
        Start Time:                  ${this.startTime.toISOString()}
        End Time:                    ${this.endTime.toISOString()}
        Total Duration:              ${Math.round(duration / 1000)} seconds
        Duration (formatted):        ${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s

        POOL STATISTICS
        ────────────────────────────────────────────────────────────────
        Total Pools Analyzed:        ${allPools.length}
        Pools Needing Update:        ${poolsNeedingUpdate.length}
        Pools Already Correct:       ${this.skippedPools.length}
        Successful Updates:          ${this.successCount}
        Failed Updates:              ${this.errorCount}
        Success Rate:                ${poolsNeedingUpdate.length > 0 ? ((this.successCount / poolsNeedingUpdate.length) * 100).toFixed(2) : 100}%

        GAS INFORMATION
        ────────────────────────────────────────────────────────────────
        Total Gas Used:              ${totalGasUsed.toString()} units
        Average Gas Price:           ${ethers.utils.formatUnits(averageGasPrice.toString(), 'gwei')} gwei
        Total Cost:                  ${ethers.utils.formatEther(totalCost.toString())} ETH
        Gas Limit per TX:            ${this.config.gasLimit}
        Max Fee per Gas:             ${ethers.utils.formatUnits(this.config.maxFeePerGas, 'gwei')} gwei
        Max Priority Fee:            ${ethers.utils.formatUnits(this.config.maxPriorityFeePerGas, 'gwei')} gwei

        CONFIGURATION SETTINGS
        ────────────────────────────────────────────────────────────────
        Batch Size:                  ${this.config.batchSize}
        Network:                     ${this.config.networkName}
        Output Directory:            ${this.config.outputDir}

        ${this.errorCount > 0 ? `
        ERRORS ENCOUNTERED (${this.errorCount})
        ────────────────────────────────────────────────────────────────
        ${this.errors.map(err => `• ${err.pool}: ${err.error}`).join('\n')}
        ` : ''}

        ═══════════════════════════════════════════════════════════════
        Report generated on: ${new Date().toISOString()}
        ═══════════════════════════════════════════════════════════════
        `;

        fs.writeFileSync(summaryFile, summary);
        console.log(`Summary report saved: ${summaryFile}`);
    }

    async generateJSONReport(reportDir, allPools, poolsNeedingUpdate, duration) {
        const report = {
            metadata: {
                timestamp: new Date().toISOString(),
                network: this.config.networkName,
                factoryAddress: this.config.factoryAddress,
                executorAddress: this.wallet.address,
                targetFeeProtocol: {
                    token0: this.config.feeProtocol0,
                    token1: this.config.feeProtocol1
                },
                execution: {
                    startTime: this.startTime.toISOString(),
                    endTime: this.endTime.toISOString(),
                    durationMs: duration,
                    durationFormatted: `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`
                }
            },
            statistics: {
                totalPoolsAnalyzed: allPools.length,
                poolsNeedingUpdate: poolsNeedingUpdate.length,
                poolsAlreadyCorrect: this.skippedPools.length,
                successfulUpdates: this.successCount,
                failedUpdates: this.errorCount,
                successRate: poolsNeedingUpdate.length > 0 ? ((this.successCount / poolsNeedingUpdate.length) * 100) : 100
            },
            gasInformation: {
                totalGasUsed: this.processedPools
                    .filter(p => p.gasUsed)
                    .reduce((sum, p) => sum + BigInt(p.gasUsed), BigInt(0)).toString(),
                averageGasPrice: this.processedPools
                    .filter(p => p.effectiveGasPrice)
                    .reduce((sum, p, _, arr) => sum + BigInt(p.effectiveGasPrice) / BigInt(arr.length), BigInt(0)).toString(),
                gasLimitPerTx: this.config.gasLimit,
                maxFeePerGas: this.config.maxFeePerGas.toString(),
                maxPriorityFeePerGas: this.config.maxPriorityFeePerGas.toString()
            },
            configuration: {
                batchSize: this.config.batchSize,
                networkName: this.config.networkName,
                outputDir: this.config.outputDir
            },
            pools: {
                all: allPools,
                processed: this.processedPools,
                skipped: this.skippedPools
            },
            errors: this.errors
        };
        
        const jsonFile = path.join(reportDir, 'complete_report.json');
        fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
        console.log(`Complete JSON report saved: ${jsonFile}`);
    }

    async initialize() {
        console.log('Initializing UniswapV3 Fee Protocol Updater...');
        console.log(`Network: ${this.config.networkName}`);
        console.log(`Factory Address: ${this.config.factoryAddress}`);
        console.log(`Wallet Address: ${this.wallet.address}`);
        console.log(`Fee Protocol Settings: token0=${this.config.feeProtocol0}, token1=${this.config.feeProtocol1}`);
        
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
            console.log(`Created output directory: ${this.config.outputDir}`);
        }
        
        const balance = await this.provider.getBalance(this.wallet.address);
        console.log(`Wallet Balance: ${ethers.utils.formatEther(balance)} ETH`);
        
        if (balance < ethers.utils.parseEther('0.1')) {
            console.warn('Warning: Wallet balance is low. Make sure you have enough ETH for gas fees.');
        }
    }

    async getAllPoolAddresses() {
        console.log(`Discovering pools using PoolCreated events...`);

        let pools = [];
        const startBlock = config.factoryDeploymentblock || 0;
        const endBlock = "latest";
    
        // Get PoolCreated events in chunks to avoid RPC limits
        const chunkSize = 10000;
        let currentBlock = Number(startBlock);
        const latestBlock = await this.provider.getBlockNumber();
        const targetBlock = endBlock === "latest" ? latestBlock : Math.min(endBlock, latestBlock);
    
        while (currentBlock <= targetBlock) {
            const toBlockChunk = Math.min(currentBlock + chunkSize - 1, targetBlock);
    
            console.log(`Scanning blocks ${currentBlock} to ${toBlockChunk}...`);
    
            try {
                const events = await this.factory.queryFilter(
                    this.factory.filters.PoolCreated(),
                    currentBlock,
                    toBlockChunk
                );
            
                for (const event of events) {
                    const { pool } = event.args;
                    const poolz = new ethers.Contract(pool, poolABI, this.provider);
                    const [slot0Data, token0, token1, fee] = await Promise.all([
                        poolz.slot0(),
                        poolz.token0(),
                        poolz.token1(),
                        poolz.fee()
                    ]);
                    
                    const currentFeeProtocol0 = slot0Data.feeProtocol % 16;
                    const currentFeeProtocol1 = slot0Data.feeProtocol >> 4;
                                    
                    pools.push({
                        address: pool,
                        token0,
                        token1,
                        fee: fee.toString(),
                        currentFeeProtocol0,
                        currentFeeProtocol1,
                        needsUpdate: currentFeeProtocol0 !== this.config.feeProtocol0 || 
                        currentFeeProtocol1 !== this.config.feeProtocol1
                    });
                }
            
                console.log(`Found ${events.length} pools in block range ${currentBlock}-${toBlockChunk}`);
            } catch (error) {
                console.warn(`Error scanning blocks ${currentBlock}-${toBlockChunk}:`, error.message);
            }
        
            currentBlock = toBlockChunk + 1;
        
            // Small delay to avoid overwhelming RPC
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`Retrieved ${pools.length} pool addresses`);
        return pools;
    }

    async updateFeeProtocol(poolAddress) {
        try {
            const pool = new ethers.Contract(poolAddress, poolABI, this.wallet);
            
            console.log(`Updating fee protocol for pool: ${poolAddress}`);
            
            const tx = await pool.setFeeProtocol(
                this.config.feeProtocol0,
                this.config.feeProtocol1,
                {
                    // gasLimit: gasLimit,
                    // maxFeePerGas: this.config.maxFeePerGas,
                    // maxPriorityFeePerGas: this.config.maxPriorityFeePerGas,
                }
            );
            
            console.log(`Transaction sent: ${tx.hash}`);
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                console.log(`Successfully updated pool: ${poolAddress}`);
                this.successCount++;
                
                // Record successful transaction
                this.processedPools.push({
                    address: poolAddress,
                    status: 'success',
                    transactionHash: tx.hash,
                    gasUsed: receipt.gasUsed.toString(),
                    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
                    timestamp: new Date().toISOString()
                });
                
                return { success: true, hash: tx.hash };
            } else {
                console.log(`Transaction failed for pool: ${poolAddress}`);
                this.errorCount++;
                
                // Record failed transaction
                this.processedPools.push({
                    address: poolAddress,
                    status: 'failed',
                    transactionHash: tx.hash,
                    error: 'Transaction failed',
                    timestamp: new Date().toISOString()
                });
                
                return { success: false, error: 'Transaction failed' };
            }
            
        } catch (error) {
            console.error(`Error updating pool ${poolAddress}: ${error.message}`);
            this.errorCount++;
            this.errors.push({ pool: poolAddress, error: error.message });
            
            // Record error
            this.processedPools.push({
                address: poolAddress,
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            return { success: false, error: error.message };
        }
    }

    async processPools() {
        const poolsInfo = await this.getAllPoolAddresses();
        
        console.log('Analyzing pools to determine which need updates...');
        
        const poolsNeedingUpdate = poolsInfo.filter(pool => pool.needsUpdate);
        const poolsAlreadyCorrect = poolsInfo.filter(pool => !pool.needsUpdate);
        
        // Record skipped pools
        this.skippedPools = poolsAlreadyCorrect.map(pool => ({
            address: pool.address,
            token0: pool.token0,
            token1: pool.token1,
            fee: pool.fee,
            currentFeeProtocol0: pool.currentFeeProtocol0,
            currentFeeProtocol1: pool.currentFeeProtocol1,
            reason: 'Already has correct fee protocol'
        }));
        
        console.log(`\nAnalysis complete:`);
        console.log(`   Total pools analyzed: ${poolsInfo.length}`);
        console.log(`   Pools needing update: ${poolsNeedingUpdate.length}`);
        console.log(`   Pools already correct: ${poolsAlreadyCorrect.length}`);
        
        if (poolsNeedingUpdate.length === 0) {
            console.log('All pools already have the correct fee protocol settings!');
            await this.generateReport(poolsInfo, []);
            return;
        }
        
        console.log('\nStarting fee protocol updates...');
        
        // Update pools in batches
        for (let i = 0; i < poolsNeedingUpdate.length; i += this.config.batchSize) {
            const batch = poolsNeedingUpdate.slice(i, i + this.config.batchSize);
            console.log(`\nProcessing batch ${Math.floor(i / this.config.batchSize) + 1} of ${Math.ceil(poolsNeedingUpdate.length / this.config.batchSize)}`);
            
            // Process batch sequentially to avoid nonce issues
            for (const poolInfo of batch) {
                await this.updateFeeProtocol(poolInfo.address);
                // Small delay between transactions
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Generate final report
        await this.generateReport(poolsInfo, poolsNeedingUpdate);
    }

    async run() {
        try {
            this.startTime = new Date();
            await this.initialize();
            await this.processPools();
            
            console.log('\nFinal Summary:');
            console.log(`   Successful updates: ${this.successCount}`);
            console.log(`   Failed updates: ${this.errorCount}`);
            
            if (this.errors.length > 0) {
                console.log('\nErrors encountered:');
                this.errors.forEach(error => {
                    console.log(`   Pool: ${error.pool} - Error: ${error.error}`);
                });
            }
            
            console.log('\nScript execution completed!');
            
        } catch (error) {
            console.error('Fatal error:', error);
            this.endTime = new Date();
            
            // Generate error report
            if (this.startTime) {
                await this.generateReport([], []);
            }
            
            process.exit(1);
        }
    }
}

function validateConfig(config) {
    const requiredEnvVars = ['RPC_URL', 'PRIVATE_KEY'];
    const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    if (!config.rpcUrl) {
        throw new Error('RPC_URL is required in environment variables');
    }
    
    if (!config.privateKey) {
        throw new Error('PRIVATE_KEY is required in environment variables');
    }
    
    if (config.feeProtocol0 !== 0 && (config.feeProtocol0 < 4 || config.feeProtocol0 > 10)) {
        throw new Error('FEE_PROTOCOL_0 must be 0 or between 4 and 10');
    }
    
    if (config.feeProtocol1 !== 0 && (config.feeProtocol1 < 4 || config.feeProtocol1 > 10)) {
        throw new Error('FEE_PROTOCOL_1 must be 0 or between 4 and 10');
    }
    
    if (isNaN(config.batchSize) || config.batchSize <= 0) {
        throw new Error('BATCH_SIZE must be a positive number');
    }
    
    if (isNaN(config.gasLimit) || config.gasLimit <= 0) {
        throw new Error('GAS_LIMIT must be a positive number');
    }
}

async function main() {
    try {
        validateConfig(config);
        
        const updater = new UniswapV3FeeProtocolUpdater(config);
        await updater.run();
        
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

async function dryRun() {
    console.log('Running in DRY RUN mode - no transactions will be sent\n');
    
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const factory = new ethers.Contract(config.factoryAddress, factoryABI, provider);
    
    const poolCount = await factory.allPoolsLength();
    console.log(`Total pools in factory: ${poolCount.toString()}`);
    
    // Sample first 10 pools
    console.log('\nSampling first 10 pools:');
    for (let i = 0; i < Math.min(10, Number(poolCount)); i++) {
        const poolAddress = await factory.allPools(i);
        const pool = new ethers.Contract(poolAddress, poolABI, provider);
        
        try {
            const [slot0Data, token0, token1, fee] = await Promise.all([
                pool.slot0(),
                pool.token0(),
                pool.token1(),
                pool.fee()
            ]);
            
            const currentFeeProtocol0 = slot0Data.feeProtocol % 16;
            const currentFeeProtocol1 = slot0Data.feeProtocol >> 4;
            
            console.log(`Pool ${i + 1}: ${poolAddress}`);
            console.log(`  Current: ${currentFeeProtocol0}/${currentFeeProtocol1}, Target: ${config.feeProtocol0}/${config.feeProtocol1}`);
            console.log(`  Fee: ${fee.toString()}, Token0: ${token0.slice(0, 10)}...`);
            
        } catch (error) {
            console.log(`Pool ${i + 1}: ${poolAddress} - Error: ${error.message}`);
        }
    }
}

module.exports = {
    UniswapV3FeeProtocolUpdater,
    config,
    main,
    dryRun
};

if (require.main === module) {
    console.log('UniswapV3 Fee Protocol Updater');
    console.log('Loading configuration from .env file...\n');
    
    // Show current configuration (without sensitive data)
    console.log('Current Configuration:');
    console.log(`  Network: ${config.networkName}`);
    console.log(`  Factory: ${config.factoryAddress}`);
    console.log(`  Fee Protocol: ${config.feeProtocol0}/${config.feeProtocol1}`);
    console.log(`  Batch Size: ${config.batchSize}`);
    console.log(`  Gas Limit: ${config.gasLimit}`);
    console.log(`  Max Fee Per Gas: ${ethers.utils.formatUnits(config.maxFeePerGas, 'gwei')} gwei`);
    console.log(`  Max Priority Fee: ${ethers.utils.formatUnits(config.maxPriorityFeePerGas, 'gwei')} gwei\n`);
    
    // Uncomment the line below for dry run testing
    // dryRun();
    
    // Uncomment the line below for actual execution
    main();
}