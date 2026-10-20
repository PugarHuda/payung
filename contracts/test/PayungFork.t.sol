// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Payung, IPriceFeed, IBorrowerOperationsSignatures} from "../src/Payung.sol";

interface IBorrowerOperations {
    function openTrove(uint256 debt, address upperHint, address lowerHint) external payable;
}

interface ITroveManager {
    function getEntireDebtAndColl(address)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}

interface ISigs {
    function getNonce(address) external view returns (uint256);
}

/// Runs against the real MUSD system on Mezo testnet (chain 31611):
/// forge test --match-contract PayungFork --fork-url https://rpc.test.mezo.org
contract PayungForkTest is Test {
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant PRICE_FEED = 0x86bCF0841622a5dAC14A313a15f96A95421b9366;
    address constant BORROWER_OPS = 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5;
    address constant SIGS = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;

    bytes32 constant REPAY_TYPEHASH = keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)");

    Payung vault;
    uint256 borrowerKey = 0xB0B;
    address borrower;
    address lp = makeAddr("lp");

    function setUp() public {
        if (block.chainid != 31611) vm.skip(true);
        borrower = vm.addr(borrowerKey);
        // Mezo's BTC oracle is a chain precompile the local EVM can't execute. Read the live
        // price over RPC and pin PriceFeed to it; every MUSD contract still runs for real.
        bytes memory raw = vm.rpc(
            "eth_call",
            string.concat('[{"to":"', vm.toString(PRICE_FEED), '","data":"0x0fdb11cf"},"latest"]')
        );
        _setPrice(abi.decode(raw, (uint256)));
        vault = new Payung(IERC20(MUSD), IPriceFeed(PRICE_FEED), IBorrowerOperationsSignatures(SIGS), address(this));
    }

    function _setPrice(uint256 price) internal {
        vm.mockCall(PRICE_FEED, abi.encodeWithSelector(IPriceFeed.fetchPrice.selector), abi.encode(price));
    }

    function _openTrove(address who, uint256 debt) internal {
        uint256 price = IPriceFeed(PRICE_FEED).fetchPrice();
        uint256 coll = debt * 2e18 / price; // ~200% collateral ratio
        vm.deal(who, coll + 1 ether);
        vm.prank(who);
        IBorrowerOperations(BORROWER_OPS).openTrove{value: coll}(debt, address(0), address(0));
    }

    function _signRepay(uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BorrowerOperationsSignatures"),
                keccak256("1"),
                block.chainid,
                SIGS
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(REPAY_TYPEHASH, amount, borrower, ISigs(SIGS).getNonce(borrower), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(borrowerKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_fork_touchRepaysRealTrove() public {
        // An underwriter mints MUSD from their own trove and funds the vault.
        _openTrove(lp, 20_000e18);
        vm.startPrank(lp);
        IERC20(MUSD).approve(address(vault), type(uint256).max);
        vault.deposit(15_000e18, lp);
        vm.stopPrank();

        // The borrower opens a trove, then insures it with auto-repay.
        _openTrove(borrower, 5_000e18);
        uint256 price = IPriceFeed(PRICE_FEED).fetchPrice();
        uint256 strike = (price * 90 / 100) / 1000e18 * 1000e18; // ~10% below spot, on the grid
        uint256 cover = 1_000e18;
        uint256 deadline = vault.currentExpiry() + 1 days;
        bytes memory sig = _signRepay(cover, deadline);

        vm.startPrank(borrower);
        IERC20(MUSD).approve(address(vault), type(uint256).max);
        uint256 id = vault.buy(strike, cover, true, deadline, sig);
        vm.stopPrank();

        (, uint256 principalBefore, uint256 interestBefore,,,) = ITroveManager(TROVE_MANAGER).getEntireDebtAndColl(borrower);

        // BTC touches the strike: the whole MUSD system sees the lower price.
        _setPrice(strike - 1e18);
        vault.trigger(strike);
        uint256 walletBefore = IERC20(MUSD).balanceOf(borrower);
        vault.claim(id, address(0), address(0));

        (, uint256 principalAfter, uint256 interestAfter,,,) = ITroveManager(TROVE_MANAGER).getEntireDebtAndColl(borrower);
        assertApproxEqAbs(principalBefore + interestBefore - (principalAfter + interestAfter), cover, 1e15);
        assertEq(IERC20(MUSD).balanceOf(borrower), walletBefore); // paid into the trove, not the wallet
        assertEq(vault.totalOwed(), 0);
    }
}
