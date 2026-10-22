// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Payung, IPriceFeed, IBorrowerOperationsSignatures} from "../src/Payung.sol";

contract MockMUSD is ERC20("MUSD", "MUSD") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockPriceFeed is IPriceFeed {
    uint256 public price = 100_000e18;
    bool public stale;

    function set(uint256 p) external {
        price = p;
    }

    function setStale(bool s) external {
        stale = s;
    }

    function fetchPrice() external view returns (uint256) {
        require(!stale, "PriceFeed: Oracle is stale.");
        return price;
    }
}

/// Burns MUSD from the caller like Mezo's BorrowerOperations; `fail` simulates a voided signature.
contract MockSigs is IBorrowerOperationsSignatures {
    MockMUSD public musd;
    bool public fail;
    mapping(address => uint256) public repaid;

    constructor(MockMUSD m) {
        musd = m;
    }

    function setFail(bool f) external {
        fail = f;
    }

    function repayMUSDWithSignature(uint256 amount, address, address, address borrower, bytes memory, uint256)
        external
    {
        require(!fail, "BorrowerOperationsSignatures: Invalid signature");
        musd.burn(msg.sender, amount);
        repaid[borrower] += amount;
    }
}

contract PayungTest is Test {
    MockMUSD musd;
    MockPriceFeed feed;
    MockSigs sigs;
    Payung vault;
    uint256 E; // this week's expiry at setUp

    address lp = makeAddr("lp");
    address lp2 = makeAddr("lp2");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(2910 weeks); // an epoch start: a full week to expiry, so quotes match the one-week table exactly
        musd = new MockMUSD();
        feed = new MockPriceFeed();
        sigs = new MockSigs(musd);
        vault = new Payung(musd, feed, sigs, address(this));
        E = vault.currentExpiry();

        for (uint256 i; i < 4; ++i) {
            address u = [lp, lp2, alice, bob][i];
            musd.mint(u, 1_000_000e18);
            vm.prank(u);
            musd.approve(address(vault), type(uint256).max);
        }
        vm.prank(lp);
        vault.deposit(100_000e18, lp);
    }

    function _buy(address who, uint256 strike, uint256 cover, bool autoRepay) internal returns (uint256) {
        uint256 expiry = vault.currentExpiry();
        uint256 deadline = expiry + 1 days;
        vm.prank(who);
        return vault.buy(expiry, strike, cover, type(uint256).max, autoRepay, deadline, autoRepay ? bytes("sig") : bytes(""));
    }

    function test_expiryIsThursdayMidnightUtc() public view {
        uint256 e = vault.currentExpiry();
        assertEq(e % 1 weeks, 0);
        assertEq((e / 1 days + 4) % 7, 4); // 1970-01-01 was a Thursday (weekday 4, Sunday = 0)
        assertGt(e, block.timestamp);
    }

    function test_premiumMatchesTableAndIsNavNeutral() public {
        uint256 navBefore = vault.totalAssets();
        (uint256 premium, uint256 distance) = vault.quote(E, 90_000e18, 1_000e18);
        assertEq(distance, 1000);
        assertEq(premium, 1_000e18 * 1602 / 10_000); // 10% below spot -> table[5]
        _buy(alice, 90_000e18, 1_000e18, false);
        assertEq(musd.balanceOf(address(vault)), 100_000e18 + premium);
        assertApproxEqAbs(vault.totalAssets(), navBefore, 1);
    }

    function test_interpolatesBetweenTablePoints() public view {
        assertEq(vault.touchProbability(550), uint256(5191)); // halfway between 5% (5736) and 6% (4645), rounded down
        assertEq(vault.touchProbability(3000), 25);
        assertEq(vault.touchProbability(0), 10_000);
    }

    function test_rejectsBadStrikes() public {
        vm.startPrank(alice);
        vm.expectRevert("Payung: bad strike");
        vault.buy(E, 90_500e18, 100e18, type(uint256).max, false, 0, "");
        vm.expectRevert("Payung: strike out of range");
        vault.buy(E, 97_000e18, 100e18, type(uint256).max, false, 0, ""); // 3% away
        vm.expectRevert("Payung: strike out of range");
        vault.buy(E, 60_000e18, 100e18, type(uint256).max, false, 0, ""); // 40% away
        vm.expectRevert("Payung: strike above spot");
        vault.buy(E, 101_000e18, 100e18, type(uint256).max, false, 0, "");
        vm.expectRevert("Payung: bad repay signature");
        vault.buy(E, 90_000e18, 100e18, type(uint256).max, true, 0, "sig");
        vm.stopPrank();
    }

    function test_cannotSellMoreCoverThanHeld() public {
        vm.prank(alice);
        vm.expectRevert("Payung: vault capacity");
        vault.buy(E, 70_000e18, 200_000e18, type(uint256).max, false, 0, "");
    }

    function test_noSalesInLastHour() public {
        vm.warp(vault.currentExpiry() - 30 minutes);
        vm.prank(alice);
        vm.expectRevert("Payung: sales closed");
        vault.buy(E, 90_000e18, 100e18, type(uint256).max, false, 0, "");
    }

    function test_touchPaysWallet() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, false);
        vm.expectRevert("Payung: not touched");
        vault.trigger(E, 90_000e18);

        feed.set(89_900e18);
        vault.trigger(E, 90_000e18);
        assertEq(vault.totalOwed(), 1_000e18);
        assertEq(vault.totalLocked(), 0);

        uint256 before = musd.balanceOf(alice);
        vault.claim(id, address(0), address(0)); // anyone (a keeper) can claim
        assertEq(musd.balanceOf(alice) - before, 1_000e18);
        assertEq(vault.totalOwed(), 0);

        vm.expectRevert("Payung: already paid");
        vault.claim(id, address(0), address(0));
    }

    function test_touchRepaysTrove() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, true);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        uint256 walletBefore = musd.balanceOf(alice);
        vault.claim(id, address(0), address(0));
        assertEq(sigs.repaid(alice), 1_000e18);
        assertEq(musd.balanceOf(alice), walletBefore); // went to the trove, not the wallet
    }

    function test_voidedSignatureFallsBackToWallet() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, true);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        sigs.setFail(true);
        uint256 before = musd.balanceOf(alice);
        vm.prank(alice); // the holder may take the wallet payout at once
        vault.claim(id, address(0), address(0));
        assertEq(musd.balanceOf(alice) - before, 1_000e18);
    }

    /// Anyone can call claim with the gas and hints they choose, which can make a valid repay fail.
    /// So a stranger can't turn a failed repay into a wallet payout until FALLBACK_DELAY has passed.
    function test_strangerCannotDivertFailedRepayToWallet() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, true);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        sigs.setFail(true);
        vm.expectRevert("Payung: repay failed");
        vault.claim(id, address(0), address(0));
        vm.warp(block.timestamp + vault.FALLBACK_DELAY() - 1);
        vm.expectRevert("Payung: repay failed");
        vault.claim(id, address(0), address(0));
        vm.warp(block.timestamp + 1);
        uint256 before = musd.balanceOf(alice);
        vault.claim(id, address(0), address(0)); // after the delay anyone may pay the wallet
        assertEq(musd.balanceOf(alice) - before, 1_000e18);
        assertEq(vault.totalOwed(), 0);
    }

    /// Past the repay signature's deadline there is no repay to protect: anyone pays the wallet at once.
    function test_afterSigDeadlineAnyonePaysTheWalletAtOnce() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, true); // signature valid until E + 1 day
        vm.warp(E - 1 hours);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        vm.warp(E + 1 days + 1);
        uint256 before = musd.balanceOf(alice);
        vault.claim(id, address(0), address(0)); // a stranger, well inside FALLBACK_DELAY of the trigger
        assertEq(musd.balanceOf(alice) - before, 1_000e18);
    }

    /// The holder may take a failed repay to the wallet the moment the strike is touched.
    function test_holderTakesFailedRepayAtOnce() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, true);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        sigs.setFail(true);
        vm.prank(alice);
        vault.claim(id, address(0), address(0));
        (,,, bool claimed,,,,) = _p(id);
        assertTrue(claimed);
    }

    function _p(uint256 id) internal view returns (address, uint64, bool, bool, uint256, uint256, uint256, bytes memory) {
        Payung.Policy memory p = vault.policy(id);
        return (p.holder, p.expiry, p.autoRepay, p.claimed, p.strike, p.cover, p.sigDeadline, p.signature);
    }

    function test_newStrikeNeedsMinimumCover() public {
        vm.prank(alice);
        vm.expectRevert("Payung: new strike needs 100 MUSD");
        vault.buy(E, 90_000e18, 99e18, type(uint256).max, false, 0, "");
        _buy(alice, 90_000e18, 100e18, false);
        // Once the strike is open, smaller cover on it sells as before.
        vm.prank(alice);
        vault.buy(E, 90_000e18, 10e18, type(uint256).max, false, 0, "");
    }

    function test_noTouchMeansCoverExpiresAndLpsKeepPremium() public {
        _buy(alice, 90_000e18, 1_000e18, false);
        uint256 premium = musd.balanceOf(address(vault)) - 100_000e18;
        vm.warp(E);
        feed.set(80_000e18); // too late: epoch is over
        vm.expectRevert("Payung: epoch over");
        vault.trigger(E, 90_000e18);
        assertEq(vault.totalAssets(), 100_000e18 + premium);
        assertEq(vault.freeLiquidity(), 100_000e18 + premium);
    }

    function test_withdrawLimitedToFreeLiquidity() public {
        vault.setMaxUtilization(10_000);
        _buy(alice, 90_000e18, 60_000e18, false);
        uint256 free = vault.freeLiquidity();
        assertLt(free, 50_000e18);
        assertEq(vault.maxWithdraw(lp), free);
        vm.prank(lp);
        vm.expectRevert();
        vault.withdraw(free + 1, lp, lp);
        vm.prank(lp);
        vault.withdraw(free, lp, lp);
    }

    function test_navMarksLossBeforeTrigger() public {
        _buy(alice, 90_000e18, 10_000e18, false);
        feed.set(90_000e18); // touched but nobody triggered yet
        assertApproxEqAbs(vault.openLiability(), 10_010e18, 1); // cover + the 10 MUSD trigger reward
        // A new LP cannot buy shares that ignore the coming payout.
        vm.prank(lp2);
        uint256 shares = vault.deposit(10_000e18, lp2);
        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        assertApproxEqRel(vault.convertToAssets(shares), 10_000e18, 1e12);
    }

    function test_staleOracleBlocksDepositsButNotExits() public {
        _buy(alice, 90_000e18, 1_000e18, false);
        feed.setStale(true);
        vm.prank(lp2);
        vm.expectRevert("PriceFeed: Oracle is stale.");
        vault.deposit(1_000e18, lp2);
        assertEq(vault.openLiability(), 1_000e18); // marked at full cover
        vm.prank(lp);
        vault.withdraw(1_000e18, lp, lp);
    }

    function test_pauseStopsSalesOnly() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, false);
        vault.pause();
        vm.prank(bob);
        vm.expectRevert();
        vault.buy(E, 90_000e18, 1_000e18, type(uint256).max, false, 0, "");
        feed.set(80_000e18);
        vault.trigger(E, 90_000e18);
        vault.claim(id, address(0), address(0));
        vm.prank(lp);
        vault.withdraw(1_000e18, lp, lp);
    }

    function test_epochRollResetsLockedCover() public {
        _buy(alice, 90_000e18, 50_000e18, false);
        vm.warp(vault.currentExpiry() + 1 hours);
        _buy(bob, 90_000e18, 50_000e18, false); // old cover no longer locks capital
        assertEq(vault.totalLocked(), 50_000e18);
    }

    function test_premiumTableGuards() public {
        uint16[26] memory t;
        for (uint256 i; i < 26; ++i) t[i] = uint16(5000 - i);
        vault.setPremiumTable(t);
        t[3] = 6000;
        vm.expectRevert("Payung: must be non-increasing");
        vault.setPremiumTable(t);
        vm.prank(alice);
        vm.expectRevert();
        vault.setPremiumTable(t);
    }

    function test_premiumDecaysWithTimeLeft() public {
        (uint256 fullWeek,) = vault.quote(E, 90_000e18, 1_000e18);
        vm.warp(block.timestamp + 126 hours); // a quarter of the week left -> distance counts double
        (uint256 lastDay,) = vault.quote(E, 90_000e18, 1_000e18);
        assertEq(lastDay, 1_000e18 * 25 / 10_000); // 10% below spot behaves like 20% over a full week: table[15]
        assertLt(lastDay, fullWeek);
    }

    function test_navAccruesPremiumSmoothlyNotAtExpiry() public {
        _buy(alice, 90_000e18, 20_000e18, false);
        uint256 last = vault.totalAssets();
        uint256 expiry = E;
        for (uint256 t = block.timestamp + 1 days; t < expiry; t += 1 days) {
            vm.warp(t);
            uint256 nav = vault.totalAssets();
            assertGe(nav, last); // premium releases to underwriters as risk decays
            last = nav;
        }
        vm.warp(expiry);
        uint256 jump = vault.totalAssets() - last;
        assertLt(jump, 20_000e18 * 30 / 10_000); // only the table floor is left to release at expiry
    }

    function test_volatilityTracksMezoPrice() public {
        assertEq(vault.volatility(), 0.5e18);
        vault.poke(); // first sample only records the price
        vm.expectRevert("Payung: too soon");
        vault.poke();
        // BTC swings 3% every hour for a day: far above 50% annualised.
        for (uint256 i; i < 24; ++i) {
            vm.warp(block.timestamp + 1 hours);
            feed.set(i % 2 == 0 ? 97_000e18 : 100_000e18);
            vault.poke();
        }
        uint256 hot = vault.volatility();
        assertGt(hot, 1e18);
        (uint256 premiumHot,) = vault.quote(E, 90_000e18, 1_000e18);
        // Then a flat week drifts vol down to the floor.
        for (uint256 i; i < 7 * 24; ++i) {
            vm.warp(block.timestamp + 1 hours);
            vault.poke();
        }
        assertEq(vault.volatility(), vault.VOL_FLOOR());
        vm.warp(2912 weeks); // a fresh epoch, full week to expiry
        (uint256 premiumCalm,) = vault.quote(vault.currentExpiry(), 90_000e18, 1_000e18);
        assertLt(premiumCalm, premiumHot);
    }

    function test_longGapRestartsSampling() public {
        vault.poke();
        vm.warp(block.timestamp + 3 days);
        feed.set(50_000e18); // a crash across a 3-day gap is not one annualised sample
        vault.poke();
        assertEq(vault.volatility(), 0.5e18);
    }

    function test_maxPremiumProtectsBuyer() public {
        (uint256 premium,) = vault.quote(E, 90_000e18, 1_000e18);
        feed.set(95_000e18); // price falls after the quote: cover is now dearer
        vm.prank(alice);
        vm.expectRevert("Payung: premium moved");
        vault.buy(E, 90_000e18, 1_000e18, premium, false, 0, "");
    }

    function test_utilizationCapsWeeklyLoss() public {
        assertEq(vault.coverCapacity(), 50_000e18);
        _buy(alice, 90_000e18, 40_000e18, false);
        vm.prank(bob);
        vm.expectRevert("Payung: vault capacity");
        vault.buy(E, 80_000e18, 20_000e18, type(uint256).max, false, 0, "");
        vm.prank(alice);
        vm.expectRevert();
        vault.setMaxUtilization(10_000);
        vm.expectRevert("Payung: bad utilization");
        vault.setMaxUtilization(10_001);
    }

    function test_holderCanRearmAutoRepay() public {
        uint256 id = _buy(alice, 90_000e18, 1_000e18, false);
        uint256 deadline = E + 1 days;
        vm.prank(bob);
        vm.expectRevert("Payung: not holder");
        vault.setAutoRepay(id, true, deadline, "sig");
        vm.prank(alice);
        vm.expectRevert("Payung: bad repay signature");
        vault.setAutoRepay(id, true, 0, "sig");
        vm.prank(alice);
        vault.setAutoRepay(id, true, deadline, "sig2");
        assertTrue(vault.policy(id).autoRepay);

        feed.set(85_000e18);
        vault.trigger(E, 90_000e18);
        vault.claim(id, address(0), address(0));
        assertEq(sigs.repaid(alice), 1_000e18);
        vm.prank(alice);
        vm.expectRevert("Payung: already paid");
        vault.setAutoRepay(id, false, 0, "");
    }

    function test_triggerPaysTheCaller() public {
        _buy(alice, 90_000e18, 1_000e18, false);
        _buy(bob, 80_000e18, 40_000e18, false);
        feed.set(79_000e18);
        uint256 before = musd.balanceOf(bob);
        vm.prank(bob);
        assertEq(vault.trigger(E, 90_000e18), 1e18); // 0.1% of 1,000
        vm.prank(bob);
        assertEq(vault.trigger(E, 80_000e18), 10e18); // capped at 10 MUSD
        assertEq(musd.balanceOf(bob) - before, 11e18);
        assertGe(musd.balanceOf(address(vault)), vault.totalOwed());
    }

    function test_fourWeekCoverPricedBySqrtTime() public view {
        (uint256 oneWeek,) = vault.quote(E, 90_000e18, 1_000e18);
        (uint256 fourWeeks,) = vault.quote(E + 3 weeks, 90_000e18, 1_000e18);
        assertEq(oneWeek, 1_000e18 * 1602 / 10_000); // 10% over one week: table[5]
        assertEq(fourWeeks, 1_000e18 * 5736 / 10_000); // 4x the time halves the distance: 10% acts like 5%
    }

    function test_expiryMustBeAWeeklyBoundaryInsideTheWindow() public {
        vm.startPrank(alice);
        vm.expectRevert("Payung: bad expiry");
        vault.buy(E + 4 weeks, 90_000e18, 100e18, type(uint256).max, false, 0, "");
        vm.expectRevert("Payung: bad expiry");
        vault.buy(E - 1 weeks, 90_000e18, 100e18, type(uint256).max, false, 0, "");
        vm.expectRevert("Payung: bad expiry");
        vault.buy(E + 1 days, 90_000e18, 100e18, type(uint256).max, false, 0, "");
        vm.stopPrank();
    }

    function test_lastHourOfTheWeekStillSellsNextWeek() public {
        vm.warp(E - 30 minutes);
        vm.startPrank(alice);
        vm.expectRevert("Payung: sales closed");
        vault.buy(E, 90_000e18, 100e18, type(uint256).max, false, 0, "");
        vault.buy(E + 1 weeks, 90_000e18, 100e18, type(uint256).max, false, 0, "");
        vm.stopPrank();
    }

    function test_multiWeekCoverStaysLockedAndTriggerableUntilItsExpiry() public {
        vm.prank(alice);
        uint256 id = vault.buy(E + 2 weeks, 90_000e18, 10_000e18, type(uint256).max, false, 0, "");
        _buy(bob, 90_000e18, 5_000e18, false); // this week, same strike: a separate line
        vm.warp(E + 1 days); // this week's cover has expired, alice's has not
        assertEq(vault.totalLocked(), 10_000e18);
        assertLe(vault.freeLiquidity() + vault.totalLocked(), musd.balanceOf(address(vault)));
        feed.set(89_000e18);
        vm.expectRevert("Payung: epoch over");
        vault.trigger(E, 90_000e18);
        vault.trigger(E + 2 weeks, 90_000e18);
        uint256 before = musd.balanceOf(alice);
        vault.claim(id, address(0), address(0));
        assertEq(musd.balanceOf(alice) - before, 10_000e18);
        assertEq(vault.totalLocked(), 0);
    }

    function test_expiredWeeksUnlockByThemselves() public {
        vm.prank(alice);
        vault.buy(E + 3 weeks, 90_000e18, 10_000e18, type(uint256).max, false, 0, "");
        vm.warp(E + 3 weeks); // its expiry
        assertEq(vault.totalLocked(), 0);
        assertEq(vault.openLiability(), 0);
        assertEq(vault.freeLiquidity(), musd.balanceOf(address(vault)));
    }

    function testFuzz_vaultAlwaysSolvent(uint256 strikeK, uint256 cover, uint256 dropBps) public {
        strikeK = bound(strikeK, 70, 95);
        cover = bound(cover, 100e18, 50_000e18);
        dropBps = bound(dropBps, 0, 5000);
        uint256 id = _buy(alice, strikeK * 1000e18, cover, false);
        feed.set(100_000e18 * (10_000 - dropBps) / 10_000);
        if (feed.price() <= strikeK * 1000e18) {
            vault.trigger(E, strikeK * 1000e18);
            vault.claim(id, address(0), address(0));
        }
        vm.startPrank(lp);
        vault.redeem(vault.maxRedeem(lp), lp, lp);
        vm.stopPrank();
        assertGe(musd.balanceOf(address(vault)), vault.totalOwed());
    }
}
