import { task } from "hardhat/config";
import fs from "fs";
import path from "path";

// After compilation, copy ABIs to core package
task("compile", "Compiles contracts and copies ABIs to core package").setAction(
  async (args, hre, runSuper) => {
    // Run the original compile task
    await runSuper(args);

    const artifactsPath = path.join(__dirname, "../artifacts/contracts");
    const targetPath = path.join(__dirname, "../../core/src/abis");

    // Ensure target directory exists
    fs.mkdirSync(targetPath, { recursive: true });

    // Copy Dorp ABI
    const dorpArtifactPath = path.join(
      artifactsPath,
      "Dorp.sol/Dorp.json"
    );

    if (fs.existsSync(dorpArtifactPath)) {
      const dorpArtifact = JSON.parse(
        fs.readFileSync(dorpArtifactPath, "utf-8")
      );
      fs.writeFileSync(
        path.join(targetPath, "Dorp.json"),
        JSON.stringify(dorpArtifact.abi, null, 2)
      );
      console.log("✓ Copied Dorp ABI to core/src/abis/");
    }

    // Copy MockToken ABI
    const mockTokenArtifactPath = path.join(
      artifactsPath,
      "MockToken.sol/MockToken.json"
    );

    if (fs.existsSync(mockTokenArtifactPath)) {
      const mockTokenArtifact = JSON.parse(
        fs.readFileSync(mockTokenArtifactPath, "utf-8")
      );
      fs.writeFileSync(
        path.join(targetPath, "MockToken.json"),
        JSON.stringify(mockTokenArtifact.abi, null, 2)
      );
      console.log("✓ Copied MockToken ABI to core/src/abis/");
    }
  }
);
