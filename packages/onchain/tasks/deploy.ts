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

/**
 * Updates environment variables in a .env file
 * @param envPath - Path to the .env file
 * @param vars - Record of environment variables to add/update
 */
function updateEnvFile(envPath: string, vars: Record<string, string>): void {
  if (!fs.existsSync(envPath)) {
    console.warn(`Warning: .env.development not found at ${envPath}`);
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf-8');

  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`^${key}=.*`, 'm');

    if (pattern.test(envContent)) {
      // Replace existing value
      envContent = envContent.replace(pattern, `${key}=${value}`);
    } else {
      // Add new line
      if (!envContent.endsWith('\n')) {
        envContent += '\n';
      }
      envContent += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`Updated ${Object.keys(vars).join(', ')} in ${envPath}`);
}

task("deploy", "Deploys the LitGhost contract")
  .addOptionalParam("token", "Token address (defaults to PyUSD on Sepolia)", "0xcac524bca292aaade2df8a05cc58f0a65b1b3bb9")
  .addOptionalParam("mode", "Environment mode for .env file (e.g., development, production)", "development")
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

    const mode = taskArgs.mode;

    const deploymentFile = path.join(deploymentsDir, `litghost-${mode}-${network.name}.json`);
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    console.log(`\nDeployment info saved to: ${deploymentFile}`);

    // Prepare environment variables to update
    const envVars = {
      VITE_CHAIN: network.name,
      VITE_CONTRACT_TOKEN: tokenAddress,
      VITE_CONTRACT_LITGHOST: contractAddress,
    };
    
    const envFileName = `.env.${mode}`;

    // Update .env.${mode} in lit-action package
    const litActionEnvPath = path.join(__dirname, '..', '..', 'lit-action', envFileName);
    updateEnvFile(litActionEnvPath, envVars);

    // Update .env.${mode} in app package
    const appEnvPath = path.join(__dirname, '..', '..', 'app', envFileName);
    updateEnvFile(appEnvPath, envVars);

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
