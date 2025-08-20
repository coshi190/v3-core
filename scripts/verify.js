const { ethers } = require("hardhat");
const hre = require("hardhat");
const fs = require("fs").promises;
const path = require("path");

const FACTORY_ABI = [
    "function allPoolsLength() external view returns (uint256)",
    "function allPools(uint256) external view returns (address)",
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
];
const POOL_ABI = [
    "function factory() external view returns (address)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function tickSpacing() external view returns (int24)",
    "function maxLiquidityPerTick() external view returns (uint128)"
];
const ERC20_ABI = [
    "function name() external view returns (string)",
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)"
];
const FACTORY_ADDRESSES = {
    tkub: "0xCBd41F872FD46964bD4Be4d72a8bEBA9D656565b",
};
const FACTORY_DEPLOYMENT_BLOCKS = {
    tkub: 23935400,
};

async function getTokenInfo(tokenAddress) {
    try {
        const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
        const [name, symbol, decimals] = await Promise.all([
            token.name().catch(() => "Unknown"),
            token.symbol().catch(() => "???"),
            token.decimals().catch(() => 18)
        ]);
        return { name, symbol, decimals };
    } catch (error) {
        return { name: "Unknown", symbol: "???", decimals: 18 };
    }
}

async function verifyPool(poolAddress, factoryAddress, retryCount = 0) {
    const maxRetries = 3;
  
    try {        
        await hre.run("verify:verify", { address: poolAddress });

        console.log(`Pool ${poolAddress} verified successfully!`);
        return { success: true, poolAddress };
    } catch (error) {
        if (error.message.includes("Already Verified")) {
            console.log(`Pool ${poolAddress} already verified`);
            return { success: true, poolAddress, alreadyVerified: true };
        }
        if (error.message.includes("rate limit") && retryCount < maxRetries) {
            const delay = (retryCount + 1) * 10000; // Exponential backoff
            console.log(`Rate limited, retrying in ${delay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return verifyPool(poolAddress, factoryAddress, retryCount + 1);
        }
    
        console.error(`Failed to verify pool ${poolAddress}:`, error.message);
        return { success: false, poolAddress, error: error.message };
    }
}

async function ensureOutputDirectory() {
    const outputDir = path.join(process.cwd(), 'verification-reports');
    try {
        await fs.access(outputDir);
    } catch {
        await fs.mkdir(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }
    return outputDir;
}

async function generateReports(results, network, options = {}) {
    const outputDir = await ensureOutputDirectory();
    const baseFilename = `pool-verification-${network}`;
    
    const summary = {
        network,
        timestamp: new Date().toISOString(),
        executionOptions: options,
        summary: {
            totalPools: results.totalPools,
            successfulVerifications: results.successCount,
            failedVerifications: results.errorCount,
            successRate: ((results.successCount / results.totalPools) * 100).toFixed(2) + '%'
        },
        pools: results.pools.map(pool => ({
            address: pool.address,
            token0: pool.token0,
            token1: pool.token1,
            fee: pool.fee,
            feePercentage: (pool.fee / 10000) + '%',
            pairName: `${pool.token0.symbol}/${pool.token1.symbol}`,
            blockNumber: pool.blockNumber,
            transactionHash: pool.transactionHash,
            index: pool.index
        })),
        verificationResults: results.results.map(result => ({
            poolAddress: result.poolAddress,
            success: result.success,
            alreadyVerified: result.alreadyVerified || false,
            error: result.error || null,
            poolInfo: {
                pairName: `${result.poolInfo.token0.symbol}/${result.poolInfo.token1.symbol}`,
                token0: result.poolInfo.token0,
                token1: result.poolInfo.token1,
                fee: result.poolInfo.fee,
                feePercentage: (result.poolInfo.fee / 10000) + '%'
            }
        }))
    };

    const jsonFilePath = path.join(outputDir, `${baseFilename}.json`);
    await fs.writeFile(jsonFilePath, JSON.stringify(summary, null, 2));
    console.log(`JSON report saved: ${jsonFilePath}`);

    const summaryText = `
        POOL VERIFICATION SUMMARY REPORT
        =====================================
        Network: ${network}
        Execution Time: ${summary.timestamp}
        Total Pools Found: ${results.totalPools}
        Successfully Verified: ${results.successCount}
        Failed Verifications: ${results.errorCount}

        SUCCESSFUL VERIFICATIONS:
        ${results.results
            .filter(r => r.success)
            .map((r, i) => `${i + 1}. ${r.poolInfo.token0.symbol}/${r.poolInfo.token1.symbol} (${(r.poolInfo.fee/10000)}%) - ${r.poolAddress}${r.alreadyVerified ? ' [Already Verified]' : ''}`)
            .join('\n')}

        ${results.errorCount > 0 ? `
        FAILED VERIFICATIONS:
        ${results.results
            .filter(r => !r.success)
            .map((r, i) => `${i + 1}. ${r.poolInfo.token0.symbol}/${r.poolInfo.token1.symbol} (${(r.poolInfo.fee/10000)}%) - ${r.poolAddress}\n   Error: ${r.error}`)
            .join('\n')}
        ` : ''}

        Report generated at: ${new Date().toLocaleString()}
    `.trim();

    const summaryFilePath = path.join(outputDir, `${baseFilename}-summary.txt`);
    await fs.writeFile(summaryFilePath, summaryText);
    console.log(`Summary report saved: ${summaryFilePath}`);

    return {
        jsonReport: jsonFilePath,
        summaryReport: summaryFilePath,
        outputDirectory: outputDir
    };
}

async function findAndVerifyAllPools(options = {}) {
    const {
        network = hre.network.name,
        batchSize = 10,
        delayBetweenBatches = 15000,
        delayBetweenVerifications = 5000,
        useEvents = true, // Use events for faster discovery
        fromBlock = null,
        toBlock = "latest",
        generateReportsFlag = true
    } = options;
    const factoryAddress = FACTORY_ADDRESSES[network];
    if (!factoryAddress) {
        throw new Error(`Factory address not found for network: ${network}`);
    }

    console.log(`Starting pool discovery of ${factoryAddress} and verification on ${network}`);

    const factory = await ethers.getContractAt(FACTORY_ABI, factoryAddress);
    let pools = [];
  
    try {
        if (useEvents) {
            console.log(`Discovering pools using PoolCreated events...`);
      
            const startBlock = fromBlock || FACTORY_DEPLOYMENT_BLOCKS[network] || 0;
            const endBlock = toBlock;
      
            // Get PoolCreated events in chunks to avoid RPC limits
            const chunkSize = 10000;
            let currentBlock = startBlock;
            const latestBlock = await ethers.provider.getBlockNumber();
            const targetBlock = endBlock === "latest" ? latestBlock : Math.min(endBlock, latestBlock);
      
            while (currentBlock <= targetBlock) {
                const toBlockChunk = Math.min(currentBlock + chunkSize - 1, targetBlock);
        
                console.log(`Scanning blocks ${currentBlock} to ${toBlockChunk}...`);
        
                try {
                    const events = await factory.queryFilter(
                        factory.filters.PoolCreated(),
                        currentBlock,
                        toBlockChunk
                    );
                
                    for (const event of events) {
                        const { token0, token1, fee, pool } = event.args;
                        const [token0Info, token1Info] = await Promise.all([
                            getTokenInfo(token0),
                            getTokenInfo(token1)
                        ]);
                    
                        pools.push({
                            address: pool,
                            token0: { address: token0, ...token0Info },
                            token1: { address: token1, ...token1Info },
                            fee: fee.toString(),
                            blockNumber: event.blockNumber,
                            transactionHash: event.transactionHash
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
        }
    
        console.log(`\nFound ${pools.length} pools to verify`);
        console.log(`\nPool Summary:`);
        pools.slice(0, 5).forEach((pool, idx) => {
            console.log(`${idx + 1}. ${pool.token0.symbol}/${pool.token1.symbol} (${pool.fee/10000}%) - ${pool.address}`);
        });
        if (pools.length > 5) {
            console.log(`... and ${pools.length - 5} more pools`);
        }
    
        console.log(`\nStarting verification process...`);
        const results = [];
        let successCount = 0;
        let errorCount = 0;
    
        for (let i = 0; i < pools.length; i += batchSize) {
            const batch = pools.slice(i, i + batchSize);
            console.log(`\n--- Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pools.length/batchSize)} (Pools ${i + 1}-${Math.min(i + batchSize, pools.length)}) ---`);
        
            for (const pool of batch) {
                console.log(`\n[${results.length + 1}/${pools.length}] Verifying ${pool.token0.symbol}/${pool.token1.symbol} pool`);
                console.log(`Fee: ${pool.fee/10000}% | Address: ${pool.address}`);
            
                const result = await verifyPool(pool.address, factoryAddress);
                results.push({ ...result, poolInfo: pool });
            
                if (result.success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            
                // Delay between individual verifications
                if (results.length < pools.length) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenVerifications));
                }
            }
      
            // Longer delay between batches
            if (i + batchSize < pools.length) {
                console.log(`\nWaiting ${delayBetweenBatches/1000}s before next batch...`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }
    
        console.log(`\nVerification Complete!`);
        console.log(`Results Summary:`);
        console.log(`Successfully verified: ${successCount}/${pools.length}`);
        console.log(`Failed to verify: ${errorCount}/${pools.length}`);
    
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
            console.log(`\nFailed Verifications:`);
            failed.forEach((result, idx) => {
                console.log(`${idx + 1}. ${result.poolInfo.token0.symbol}/${result.poolInfo.token1.symbol} - ${result.poolAddress}`);
                console.log(`   Error: ${result.error}`);
            });
        }

        const finalResults = {
            totalPools: pools.length,
            successCount,
            errorCount,
            results,
            pools
        };

        if (generateReportsFlag) {
            console.log(`\nGenerating reports...`);
            const reportPaths = await generateReports(finalResults, network, options);
            console.log(`\nReports generated successfully!`);
            console.log(`Output directory: ${reportPaths.outputDirectory}`);
            console.log(`JSON Report: ${reportPaths.jsonReport}`);
            console.log(`CSV Report: ${reportPaths.csvReport}`);
            console.log(`Summary Report: ${reportPaths.summaryReport}`);
            
            finalResults.reportPaths = reportPaths;
        }
    
        return finalResults;
    } catch (error) {
        console.error(`Fatal error in pool discovery/verification:`, error);
        throw error;
    }
}

async function main() {
    try {
        const results = await findAndVerifyAllPools({
            network: hre.network.name,
            useEvents: true,
            batchSize: 5,
            delayBetweenVerifications: 8000,
            delayBetweenBatches: 20000,
            fromBlock: null,
            generateReportsFlag: true
        });
        
        console.log(`\nVerification process completed with reports!`);
        if (results.reportPaths) {
            console.log(`All reports saved in: ${results.reportPaths.outputDirectory}`);
        }
    } catch (error) {
        console.error("Script failed:", error);
        process.exit(1);
    }
}

if (require.main === module) {
  main()
    .then(() => {
        console.log("\nScript completed successfully!");
        process.exit(0);
    })
    .catch((error) => {
        console.error("\nScript failed:", error);
        process.exit(1);
    });
}

module.exports = {
    findAndVerifyAllPools,
    generateReports
};