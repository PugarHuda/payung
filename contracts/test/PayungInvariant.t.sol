// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Payung} from "../src/Payung.sol";
import {MockMUSD, MockPriceFeed, MockSigs} from "./Payung.t.sol";

/// Drives the vault through random sequences of real user actions.
contract Handler is Test {
    Payung public vault;
    MockMUSD public musd;
    MockPriceFeed public feed;
    MockSigs public sigs;
    address[] public actors;
    uint256[] public ids;
    uint256 public paidOut; // every MUSD that left as a payout or trigger reward

    constructor(Payung v, MockMUSD m, MockPriceFeed f, MockSigs s) {
        vault = v;
        musd = m;
        feed = f;
        sigs = s;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            m.mint(a, 10_000_000e18);
            vm.prank(a);
            m.approve(address(v), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1e18, 200_000e18);
        vm.prank(_actor(seed));
        vault.deposit(amount, _actor(seed));
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        uint256 max = vault.maxWithdraw(a);
        if (max == 0) return;
        vm.prank(a);
        vault.withdraw(bound(amount, 1, max), a, a);
    }

    function buy(uint256 seed, uint256 weeksOut, uint256 distancePct, uint256 cover, bool autoRepay) external {
        uint256 expiry = vault.currentExpiry() + bound(weeksOut, 0, vault.MAX_WEEKS() - 1) * 1 weeks;
        uint256 price = feed.price();
        uint256 strike = (price * (100 - bound(distancePct, 6, 29)) / 100) / 1000e18 * 1000e18;
        cover = bound(cover, 10e18, 50_000e18);
        if (cover > vault.coverCapacity() || block.timestamp + 1 hours >= expiry) return;
        (, uint256 distance) = vault.quote(expiry, strike, cover);
        if (distance < 500 || distance > 3000) return;
        bytes memory call =
            abi.encodeCall(vault.buy, (expiry, strike, cover, type(uint256).max, autoRepay, expiry + 1 days, "sig"));
        vm.prank(_actor(seed)); // after building the call: a view call in the arguments would eat the prank
        (bool ok,) = address(vault).call(call);
        if (ok) {
            ids.push(vault.policyCount() - 1);
        } else {
            // Only a strike already touched this epoch, or a full strike list, may refuse a valid buy.
            (, bool triggered) = vault.strikes(expiry, strike);
            assertTrue(triggered || vault.strikeList(expiry).length >= vault.MAX_STRIKES(), "valid buy reverted");
        }
    }

    function movePrice(uint256 bps, bool up) external {
        bps = bound(bps, 0, 1500);
        uint256 p = feed.price();
        uint256 next = up ? p * (10_000 + bps) / 10_000 : p * (10_000 - bps) / 10_000;
        feed.set(bound(next, 20_000e18, 300_000e18));
    }

    function trigger(uint256 weeksOut, uint256 i) external {
        uint256 expiry = vault.currentExpiry() + bound(weeksOut, 0, vault.MAX_WEEKS() - 1) * 1 weeks;
        uint256[] memory list = vault.strikeList(expiry);
        if (list.length == 0) return;
        uint256 strike = list[i % list.length];
        (uint256 cover, bool triggered) = vault.strikes(expiry, strike);
        if (triggered || cover == 0 || feed.price() > strike) return;
        paidOut += vault.trigger(expiry, strike);
    }

    function claim(uint256 i, bool failRepay) external {
        if (ids.length == 0) return;
        uint256 id = ids[i % ids.length];
        Payung.Policy memory p = vault.policy(id);
        (, bool triggered) = vault.strikes(p.expiry, p.strike);
        if (p.claimed || !triggered) return;
        sigs.setFail(failRepay);
        vault.claim(id, address(0), address(0));
        paidOut += p.cover;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 2 days));
    }

    function poke() external {
        try vault.poke() {} catch {}
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract PayungInvariantTest is Test {
    Payung vault;
    MockMUSD musd;
    MockPriceFeed feed;
    Handler internal handler;

    function setUp() public {
        vm.warp(2910 weeks);
        musd = new MockMUSD();
        feed = new MockPriceFeed();
        MockSigs sigs = new MockSigs(musd);
        vault = new Payung(musd, feed, sigs, address(this));
        handler = new Handler(vault, musd, feed, sigs);
        targetContract(address(handler));
    }

    /// Every triggered-but-unpaid policy is backed by MUSD in the vault.
    function invariant_owedIsBacked() public view {
        assertGe(musd.balanceOf(address(vault)), vault.totalOwed());
    }

    /// Open cover of every live expiry is fully backed on top of what is owed.
    function invariant_openCoverIsBacked() public view {
        assertGe(musd.balanceOf(address(vault)), vault.totalOwed() + vault.totalLocked());
    }

    /// NAV never counts MUSD that is owed or at risk.
    function invariant_navIsConservative() public view {
        assertLe(vault.totalAssets() + vault.totalOwed(), musd.balanceOf(address(vault)));
    }

    /// totalOwed equals the cover of triggered policies not yet paid.
    function invariant_owedMatchesPolicies() public view {
        uint256 owed;
        for (uint256 i; i < handler.idCount(); ++i) {
            Payung.Policy memory p = vault.policy(handler.ids(i));
            (, bool triggered) = vault.strikes(p.expiry, p.strike);
            if (triggered && !p.claimed) owed += p.cover;
        }
        assertEq(owed, vault.totalOwed());
    }

    /// The run really sold cover (handlers can bail out early on invalid input).
    function afterInvariant() external view {
        assertGt(handler.idCount(), 0, "no cover was ever bought");
    }

    /// Volatility stays inside its clamp whatever the price path.
    function invariant_volatilityClamped() public view {
        uint256 v = vault.volatility();
        assertGe(v, vault.VOL_FLOOR());
        assertLe(v, vault.VOL_CAP());
    }
}
