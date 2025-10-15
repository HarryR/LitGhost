import '@nomicfoundation/hardhat-ethers';
import 'hardhat-tracer';
import '@nomicfoundation/hardhat-chai-matchers';
import "@nomicfoundation/hardhat-verify";
import '@typechain/hardhat';
import { HardhatUserConfig, vars } from 'hardhat/config';
import './tasks/compile';
import './tasks/deploy';

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      chainId: 1337, // @see https://hardhat.org/metamask-issue.html
    },
    hardhat_local: {
      url: 'http://127.0.0.1:8545/',
    },
    sepolia: {
      chainId: 11155111,
      url: vars.get('SEPOLIA_RPC_URL', 'https://1rpc.io/sepolia'),
      accounts: [
        vars.get('PROJECT_KEY_TEST')
      ]
    },
    polygon_amoy: {
      chainId: 80002,
      url: 'https://api.zan.top/polygon-amoy',
      accounts: [
        vars.get('PROJECT_KEY_TEST')
      ]
    }
  },
  sourcify: {
    enabled: false
  },
  etherscan: {
    enabled: true,
    apiKey: vars.get('ETHERSCAN_API_KEY'),
    customChains: [
      {
        network: "polygon_amoy",
        chainId: 80002,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://amoy.polygonscan.com/"
        }
      }
    ]
  },
  solidity: {
    compilers: [
      {
        version: '0.8.27',
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            //enabled: false,
            //runs: 2000,
          },
          viaIR: true,
          //viaIR: false,
        },
      }
    ],
  },
  typechain: {
    target: 'ethers-v6',
    outDir: 'src/contracts',
  },
  mocha: {
    require: ['ts-node/register/files'],
    timeout: 50_000,
  },
};

export default config;
