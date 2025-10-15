import { task } from "hardhat/config";
import * as fs from 'fs';
import * as path from 'path';

interface DeploymentInfo {
  network: string;
  contractAddress: string;
  transactionHash: string;
  deploymentTimestamp: string;
  tokenAddress: string;
  deployer: string;
}

task("deploy", "Deploys the LitGhost contract")
  .addOptionalParam("token", "Token address (defaults to PyUSD on Sepolia)", "0xcac524bca292aaade2df8a05cc58f0a65b1b3bb9")
  .addFlag("verify", "Verify contract on Etherscan after deployment")
  .setAction(async (taskArgs, hre) => {
    const { ethers, run, network } = hre;

    console.log(`Deploying LitGhost contract to ${network.name}...`);

    const tokenAddress = taskArgs.token;
    console.log(`Using token address: ${tokenAddress}`);

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log(`Deploying with account: ${deployer.address}`);

    // Get account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);
    if( balance === 0n ) {
      throw new Error('Deployer account has no balance!');
    }

    // Deploy the contract
    console.log('\nDeploying LitGhost contract...');
    const LitGhostFactory = await ethers.getContractFactory('LitGhost');
    const litGhost = await LitGhostFactory.deploy(tokenAddress);
    
    const deploymentTx = litGhost.deploymentTransaction();
    if (!deploymentTx) {
      throw new Error('Deployment transaction not found');
    }

    const contractAddress = await litGhost.getAddress();
    console.log(`\nLitGhost deployed to: ${contractAddress}`);
    console.log(`Transaction hash: ${deploymentTx.hash}`);

    // Prepare deployment info
    const deploymentInfo: DeploymentInfo = {
      network: network.name,
      contractAddress: contractAddress,
      transactionHash: deploymentTx.hash,
      deploymentTimestamp: new Date().toISOString(),
      tokenAddress: tokenAddress,
      deployer: deployer.address
    };

    // Save deployment info to JSON file
    const deploymentsDir = path.join(__dirname, '..', 'deployments');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const deploymentFile = path.join(deploymentsDir, `litghost-${network.name}.json`);
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    console.log(`\nDeployment info saved to: ${deploymentFile}`);

    // Update .env.development in lit-action package
    const envPath = path.join(__dirname, '..', '..', 'lit-action', '.env.development');

    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf-8');

      // Check if VITE_CONTRACT_LITGHOST already exists
      if (envContent.includes('VITE_CONTRACT_LITGHOST=')) {
        // Replace existing value
        envContent = envContent.replace(
          /VITE_CONTRACT_LITGHOST=.*/,
          `VITE_CONTRACT_LITGHOST=${contractAddress}`
        );
      } else {
        // Add new line
        if (!envContent.endsWith('\n')) {
          envContent += '\n';
        }
        envContent += `VITE_CONTRACT_LITGHOST=${contractAddress}\n`;
      }

      fs.writeFileSync(envPath, envContent);
      console.log(`Updated VITE_CONTRACT_LITGHOST in ${envPath}`);
    } else {
      console.warn(`Warning: .env.development not found at ${envPath}`);
    }

    // Verify contract on Etherscan
    if (taskArgs.verify && network.name !== 'hardhat' && network.name !== 'hardhat_local') {
      console.log('\nWaiting for block confirmations before verification...');
      await deploymentTx.wait(5); // Wait for 5 confirmations

      console.log('\nVerifying contract on Etherscan...');
      try {
        await run('verify:verify', {
          address: contractAddress,
          constructorArguments: [tokenAddress],
        });
        console.log('Contract verified successfully!');
      } catch (error: any) {
        if (error.message.toLowerCase().includes('already verified')) {
          console.log('Contract is already verified!');
        } else {
          console.error('Error verifying contract:', error);
        }
      }
    }

    console.log('\n=== Deployment Summary ===');
    console.log(`Network: ${network.name}`);
    console.log(`LitGhost Contract: ${contractAddress}`);
    console.log(`Token Address: ${tokenAddress}`);
    console.log(`Transaction: ${deploymentTx.hash}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log('==========================\n');

    return {
      contractAddress,
      transactionHash: deploymentTx.hash,
      tokenAddress,
    };
  });
