import 'hardhat-typechain'
import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-waffle'
import '@nomiclabs/hardhat-etherscan'

export default {
  networks: {
    'jbc': { url: 'https://rpc-l1.jibchain.net' },
    'kub': { url: 'https://rpc.bitkubchain.io' },
    'tkub': { url: 'https://rpc-testnet.bitkubchain.io' },
    'tmonad': { url: 'https://testnet-rpc.monad.xyz' },
  },
  etherscan: {
    apiKey: {
      'jbc': 'empty',
      'kub': 'empty',
      'tkub': 'empty',
      'tmonad': 'empty'
    },
    customChains: [
      {
        network: "jbc",
        chainId: 8899,
        urls: {
          apiURL: "https://exp.jibchain.net/api",
          browserURL: "https://exp.jibchain.net"
        }
      },
      {
        network: "kub",
        chainId: 96,
        urls: {
          apiURL: "https://www.kubscan.com/api",
          browserURL: "https://www.kubscan.com"
        }
      },
      {
        network: "tkub",
        chainId: 25925,
        urls: {
          apiURL: "https://testnet.kubscan.com/api",
          browserURL: "https://www.kubscan.com"
        }
      },
      {
        network: "tmonad",
        chainId: 10143,
        urls: {
          apiURL: "https://api.socialscan.io/monad-testnet/v1/explorer/command_api/contract",
          browserURL: "https://testnet.monadexplorer.com"
        }
      }
    ]
  },
  solidity: {
    version: '0.7.6',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      metadata: {
        // do not include the metadata hash, since this is machine dependent
        // and we want all generated code to be deterministic
        // https://docs.soliditylang.org/en/v0.7.6/metadata.html
        bytecodeHash: 'none',
      },
    },
  },
}
