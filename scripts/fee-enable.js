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
} else {
    console.error('.env file not found.');
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
    outputDir: process.env.OUTPUT_DIR || './',
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
        const reportDir = path.join(this.config.outputDir, `fee-enable-report`);
        
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
                
        await this.generateSummaryReport(reportDir, allPools, poolsNeedingUpdate);                
    }

    async generateSummaryReport(reportDir, allPools, poolsNeedingUpdate) {
        const summaryFile = path.join(reportDir, this.config.networkName + '-summary.txt');

        const poolsAlreadyCorrect = allPools.filter(p => !p.needsUpdate);

        const needingUpdateList = poolsNeedingUpdate
            .map(p => `• ${p.address} | ${p.token0} - ${p.token1}`)
            .join('\n    ');
        const alreadyCorrectList = poolsAlreadyCorrect
            .map(p => `• ${p.address} | ${p.token0} - ${p.token1}`)
            .join('\n    ');

        const summary = `
    ═══════════════════════════════════════════════════════════════
    CMSWAP FEE PROTOCOL UPDATE REPORT
    ═══════════════════════════════════════════════════════════════

    EXECUTION SUMMARY
    ────────────────────────────────────────────────────────────────
    Network:                     ${this.config.networkName}
    Factory Address:             ${this.config.factoryAddress}
    Executor Address:            ${this.wallet.address}
    Target Fee Protocol:         ${this.config.feeProtocol0}/${this.config.feeProtocol1}

    POOL STATISTICS
    ────────────────────────────────────────────────────────────────
    Total Pools Analyzed:        ${allPools.length}
    Pools Needing Update:        ${poolsNeedingUpdate.length}
    Pools Already Correct:       ${this.skippedPools.length}
    Successful Updates:          ${this.successCount}
    Failed Updates:              ${this.errorCount}
    Success Rate:                ${poolsNeedingUpdate.length > 0 ? ((this.successCount / poolsNeedingUpdate.length) * 100).toFixed(2) : 100}%

    POOLS NEEDING UPDATE (${poolsNeedingUpdate.length})
    ────────────────────────────────────────────────────────────────
    ${needingUpdateList || '• None'}

    POOLS ALREADY CORRECT (${poolsAlreadyCorrect.length})
    ────────────────────────────────────────────────────────────────
    ${alreadyCorrectList || '• None'}

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

    async initialize() {        
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
            console.log(`Created output directory: ${this.config.outputDir}`);
        }
        
        const balance = await this.provider.getBalance(this.wallet.address);
        console.log(`Wallet Balance: ${ethers.utils.formatEther(balance)}`);
    }

    async getAllPoolAddresses() {
        console.log(`Discovering pools using PoolCreated events...`);

        let pools = [];
        const startBlock = config.factoryDeploymentblock || 0;
        const endBlock = "latest";
    
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
        
            await new Promise(resolve => setTimeout(resolve, 1000)); // Small delay to avoid overwhelming RPC
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
                // { gasLimit: gasLimit, maxFeePerGas: this.config.maxFeePerGas, maxPriorityFeePerGas: this.config.maxPriorityFeePerGas, }
            );
            
            console.log(`Transaction sent: ${tx.hash}`);
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                console.log(`Successfully updated pool: ${poolAddress}`);
                this.successCount++;
                
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
        
        for (let i = 0; i < poolsNeedingUpdate.length; i += this.config.batchSize) {
            const batch = poolsNeedingUpdate.slice(i, i + this.config.batchSize);
            console.log(`\nProcessing batch ${Math.floor(i / this.config.batchSize) + 1} of ${Math.ceil(poolsNeedingUpdate.length / this.config.batchSize)}`);
            
            for (const poolInfo of batch) { // Process batch sequentially to avoid nonce issues
                await this.updateFeeProtocol(poolInfo.address);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Small delay between transactions
            }
        }
        
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
            
            if (this.startTime) {
                await this.generateReport([], []);
            }
            
            process.exit(1);
        }
    }
}

async function main() {
    try {        
        const updater = new UniswapV3FeeProtocolUpdater(config);
        await updater.run();
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

module.exports = {
    UniswapV3FeeProtocolUpdater,
    config,
    main
};

if (require.main === module) {
    main();
}

// run with NODE_TLS_REJECT_UNAUTHORIZED=0 for kub rpc due to TLS certificate verification issue
