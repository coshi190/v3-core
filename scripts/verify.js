const { ethers } = require("hardhat");
const hre = require("hardhat");

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
  kub: "0x090C6E5fF29251B1eF9EC31605Bdd13351eA316C",
};
const FACTORY_DEPLOYMENT_BLOCKS = {
  kub: 96,
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
    console.log(`🔧 Getting constructor arguments for pool: ${poolAddress}`);
        
    await hre.run("verify:verify", {
      address: poolAddress,
      // Adjust contract path as needed - you may need to specify the exact contract
      // contract: "@uniswap/v3-core/contracts/UniswapV3Pool.sol:UniswapV3Pool"
    });

    console.log(`✅ Pool ${poolAddress} verified successfully!`);
    return { success: true, poolAddress };

  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log(`ℹ️ Pool ${poolAddress} already verified`);
      return { success: true, poolAddress, alreadyVerified: true };
    }
    
    if (error.message.includes("rate limit") && retryCount < maxRetries) {
      const delay = (retryCount + 1) * 10000; // Exponential backoff
      console.log(`⏳ Rate limited, retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return verifyPool(poolAddress, factoryAddress, retryCount + 1);
    }
    
    console.error(`❌ Failed to verify pool ${poolAddress}:`, error.message);
    return { success: false, poolAddress, error: error.message };
  }
}

async function findAndVerifyAllPools(options = {}) {
  const {
    network = hre.network.name,
    startIndex = 0,
    endIndex = null,
    batchSize = 10,
    delayBetweenBatches = 15000, // 15 seconds
    delayBetweenVerifications = 5000, // 5 seconds
    useEvents = true, // Use events for faster discovery
    fromBlock = null,
    toBlock = "latest"
  } = options;

  console.log(`🚀 Starting pool discovery and verification on ${network}`);
  
  const factoryAddress = FACTORY_ADDRESSES[network];
  if (!factoryAddress) {
    throw new Error(`Factory address not found for network: ${network}`);
  }

  const factory = await ethers.getContractAt(FACTORY_ABI, factoryAddress);
  let pools = [];
  
  try {
    if (useEvents) {
      console.log(`📡 Discovering pools using PoolCreated events...`);
      
      const startBlock = fromBlock || FACTORY_DEPLOYMENT_BLOCKS[network] || 0;
      const endBlock = toBlock;
      
      // Get PoolCreated events in chunks to avoid RPC limits
      const chunkSize = 10000;
      let currentBlock = startBlock;
      const latestBlock = await ethers.provider.getBlockNumber();
      const targetBlock = endBlock === "latest" ? latestBlock : Math.min(endBlock, latestBlock);
      
      while (currentBlock <= targetBlock) {
        const toBlockChunk = Math.min(currentBlock + chunkSize - 1, targetBlock);
        
        console.log(`🔍 Scanning blocks ${currentBlock} to ${toBlockChunk}...`);
        
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
          console.warn(`⚠️ Error scanning blocks ${currentBlock}-${toBlockChunk}:`, error.message);
        }
        
        currentBlock = toBlockChunk + 1;
        
        // Small delay to avoid overwhelming RPC
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else {
      console.log(`📊 Getting total pool count from factory...`);
      const totalPools = await factory.allPoolsLength();
      console.log(`📈 Total pools in factory: ${totalPools.toString()}`);
      
      const start = startIndex;
      const end = endIndex || totalPools.toNumber();
      
      console.log(`🔍 Discovering pools from index ${start} to ${end}...`);
      
      for (let i = start; i < end; i++) {
        try {
          const poolAddress = await factory.allPools(i);
          const pool = await ethers.getContractAt(POOL_ABI, poolAddress);
          
          const [token0Address, token1Address, fee] = await Promise.all([
            pool.token0(),
            pool.token1(),
            pool.fee()
          ]);
          
          const [token0Info, token1Info] = await Promise.all([
            getTokenInfo(token0Address),
            getTokenInfo(token1Address)
          ]);
          
          pools.push({
            address: poolAddress,
            token0: { address: token0Address, ...token0Info },
            token1: { address: token1Address, ...token1Info },
            fee: fee.toString(),
            index: i
          });
          
          if ((i + 1) % 50 === 0) {
            console.log(`📊 Discovered ${i + 1} pools...`);
          }
        } catch (error) {
          console.warn(`⚠️ Error getting pool at index ${i}:`, error.message);
        }
      }
    }
    
    console.log(`\n🎯 Found ${pools.length} pools to verify`);
    
    // Display pool summary
    console.log(`\n📋 Pool Summary:`);
    pools.slice(0, 5).forEach((pool, idx) => {
      console.log(`${idx + 1}. ${pool.token0.symbol}/${pool.token1.symbol} (${pool.fee/10000}%) - ${pool.address}`);
    });
    if (pools.length > 5) {
      console.log(`... and ${pools.length - 5} more pools`);
    }
    
    // Verification process
    console.log(`\n🔐 Starting verification process...`);
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < pools.length; i += batchSize) {
      const batch = pools.slice(i, i + batchSize);
      console.log(`\n--- Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pools.length/batchSize)} (Pools ${i + 1}-${Math.min(i + batchSize, pools.length)}) ---`);
      
      for (const pool of batch) {
        console.log(`\n🔍 [${results.length + 1}/${pools.length}] Verifying ${pool.token0.symbol}/${pool.token1.symbol} pool`);
        console.log(`💰 Fee: ${pool.fee/10000}% | Address: ${pool.address}`);
        
        const result = await verifyPool(pool.address, factoryAddress);
        results.push({
          ...result,
          poolInfo: pool
        });
        
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
        console.log(`\n⏳ Waiting ${delayBetweenBatches/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    // Final summary
    console.log(`\n🎉 Verification Complete!`);
    console.log(`📊 Results Summary:`);
    console.log(`✅ Successfully verified: ${successCount}/${pools.length}`);
    console.log(`❌ Failed to verify: ${errorCount}/${pools.length}`);
    console.log(`📈 Success rate: ${((successCount/pools.length) * 100).toFixed(1)}%`);
    
    // Show failed verifications
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      console.log(`\n❌ Failed Verifications:`);
      failed.forEach((result, idx) => {
        console.log(`${idx + 1}. ${result.poolInfo.token0.symbol}/${result.poolInfo.token1.symbol} - ${result.poolAddress}`);
        console.log(`   Error: ${result.error}`);
      });
    }
    
    return {
      totalPools: pools.length,
      successCount,
      errorCount,
      results,
      pools
    };
    
  } catch (error) {
    console.error(`💥 Fatal error in pool discovery/verification:`, error);
    throw error;
  }
}

// Convenience function for common use cases
async function verifyAllPoolsOnNetwork(network, options = {}) {
  return findAndVerifyAllPools({
    network,
    ...options
  });
}

// Example usage
async function main() {
  try {
    // Verify all pools (use events for faster discovery)
    await findAndVerifyAllPools({
      network: hre.network.name,
      useEvents: true,
      batchSize: 5, // Smaller batches to avoid rate limits
      delayBetweenVerifications: 8000, // 8 seconds between verifications
      delayBetweenBatches: 20000, // 20 seconds between batches
      fromBlock: 25242484,
    });
    
    // Alternative: Verify specific range using pool indices
    /*
    await findAndVerifyAllPools({
      network: hre.network.name,
      useEvents: false,
      startIndex: 0,
      endIndex: 100, // First 100 pools only
      batchSize: 10
    });
    */
    
  } catch (error) {
    console.error("Script failed:", error);
    process.exit(1);
  }
}

// Export functions
module.exports = {
  findAndVerifyAllPools,
  verifyAllPoolsOnNetwork,
  verifyPool,
  getTokenInfo,
  FACTORY_ADDRESSES
};

// Run if executed directly
if (require.main === module) {
  main()
    .then(() => {
      console.log("\n🏁 Script completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Script failed:", error);
      process.exit(1);
    });
}