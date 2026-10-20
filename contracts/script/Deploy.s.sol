// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Payung, IPriceFeed, IBorrowerOperationsSignatures} from "../src/Payung.sol";

/// forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (Payung vault) {
        require(block.chainid == 31611, "Mezo testnet only");
        vm.startBroadcast();
        vault = new Payung(
            IERC20(0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503), // MUSD
            IPriceFeed(0x86bCF0841622a5dAC14A313a15f96A95421b9366), // MUSD PriceFeed
            IBorrowerOperationsSignatures(0xD757e3646AF370b15f32EB557F0F8380Df7D639e),
            msg.sender
        );
        vm.stopBroadcast();
        console.log("Payung:", address(vault));
    }
}
