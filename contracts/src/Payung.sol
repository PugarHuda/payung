// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Mezo MUSD PriceFeed: BTC/USD with 18 decimals, reverts if the oracle is older than 60s.
interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/// @dev Mezo MUSD BorrowerOperationsSignatures. Repays `_amount` of `_borrower`'s trove,
/// burning MUSD from msg.sender, if `_borrower` signed RepayMUSD(amount,borrower,nonce,deadline).
interface IBorrowerOperationsSignatures {
    function repayMUSDWithSignature(
        uint256 _amount,
        address _upperHint,
        address _lowerHint,
        address _borrower,
        bytes memory _signature,
        uint256 _deadline
    ) external;
}

/// @title Payung — liquidation cover for Mezo MUSD borrowers
/// @notice Underwriters deposit MUSD into this ERC-4626 vault. Borrowers buy one-touch cover
/// for one to four weeks: if the Mezo BTC price touches the strike before expiry (a Thursday
/// 00:00 UTC, the Mezo Earn epoch boundary), the cover pays a fixed MUSD
/// amount, either straight into the borrower's trove (pre-signed repay) or to their wallet.
/// Every policy is fully collateralised, and open cover never exceeds `maxUtilization` of the vault.
/// Premiums scale with time left in the epoch and with BTC volatility measured on-chain from
/// Mezo's own PriceFeed (`poke`), so no external vol oracle is trusted.
contract Payung is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCH = 1 weeks; // unix 0 was a Thursday 00:00 UTC
    uint256 public constant SALE_CUTOFF = 1 hours; // no sales in the last hour of an epoch
    uint256 public constant STRIKE_STEP = 1000e18; // strikes on a $1,000 grid
    uint256 public constant MIN_DISTANCE_BPS = 500; // strike at least 5% below spot
    uint256 public constant MAX_DISTANCE_BPS = 3000; // and at most 30% below
    uint256 public constant MAX_WEEKS = 4; // cover can run to this week's expiry or up to 3 weeks after
    uint256 public constant MAX_STRIKES = 32; // per expiry: covers the 5-30% band at today's prices, bounds the NAV loop
    uint256 public constant MIN_COVER = 10e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant TABLE_SIZE = 26; // one entry per 1% from 5% to 30%
    // Leaves room for the repay so a keeper cannot starve it into the fallback path.
    uint256 public constant REPAY_GAS = 800_000;
    // Mezo's oracle keeps no price history, so a touch counts only if someone calls `trigger`
    // while BTC is below the strike. Paying the caller makes watching worth it for anyone.
    uint256 public constant TRIGGER_REWARD_BPS = 10; // 0.1% of the touched cover
    uint256 public constant MAX_TRIGGER_REWARD = 10e18;
    uint256 public constant VOL_REF = 0.5e18; // annualised vol the premium table was built for
    uint256 public constant VOL_FLOOR = 0.35e18; // calm markets never price cover below this vol
    uint256 public constant VOL_CAP = 2e18;
    uint256 public constant OBSERVE_INTERVAL = 15 minutes; // min spacing of vol samples
    uint256 public constant OBSERVE_MAX_GAP = 1 days; // longer gaps restart sampling instead of one huge sample
    uint256 public constant VOL_TAU = 1 days; // EWMA time constant

    IPriceFeed public immutable priceFeed;
    IBorrowerOperationsSignatures public immutable borrowerOpsSigs;

    struct Policy {
        address holder;
        uint64 expiry;
        bool autoRepay;
        bool claimed;
        uint256 strike;
        uint256 cover;
        uint256 sigDeadline;
        bytes signature;
    }

    struct Strike {
        uint256 cover; // total cover sold at this strike
        bool triggered;
    }

    /// @notice Touch probability (bps, with margin) by distance below spot: index i = (5 + i)%.
    /// ponytail: fixed one-week table derived offline (50% vol, 1.25x margin); owner refreshes
    /// it when vol moves. Upgrade path: on-chain vol oracle + closed-form barrier pricing.
    uint16[TABLE_SIZE] public premiumTable;

    Policy[] internal _policies;
    mapping(address => uint256[]) internal _policiesOf;
    mapping(uint256 => mapping(uint256 => Strike)) public strikes; // expiry => strike => state
    mapping(uint256 => uint256[]) internal _strikeList; // expiry => strikes sold

    mapping(uint256 => uint256) public lockedCover; // expiry => untriggered cover (collateral locked until then)
    uint256 public totalOwed; // triggered cover not yet paid out
    uint256 public maxUtilization = 5000; // bps of (vault MUSD - owed) that open cover may lock

    // EWMA of annualised variance (wad) of BTC returns sampled from the Mezo PriceFeed.
    // ponytail: simple returns at >=15 min spacing; fine for 15 min-1 day steps, not tick data.
    uint256 public variance = VOL_REF * VOL_REF / 1e18;
    uint128 public lastObservedPrice;
    uint64 public lastObservedAt;

    event PolicyBought(
        uint256 indexed id, address indexed holder, uint256 expiry, uint256 strike, uint256 cover, uint256 premium, bool autoRepay
    );
    event StrikeTriggered(
        uint256 indexed expiry, uint256 indexed strike, uint256 price, uint256 cover, address caller, uint256 reward
    );
    event PolicyPaid(uint256 indexed id, address indexed holder, uint256 cover, bool repaidTrove);
    event PremiumTableUpdated(uint16[TABLE_SIZE] table);
    event MaxUtilizationUpdated(uint256 bps);
    event VolatilityObserved(uint256 price, uint256 volatility);
    event AutoRepayUpdated(uint256 indexed id, bool autoRepay, uint256 sigDeadline);

    constructor(IERC20 musd, IPriceFeed priceFeed_, IBorrowerOperationsSignatures borrowerOpsSigs_, address owner_)
        ERC20("Payung MUSD Cover Vault", "pyMUSD")
        ERC4626(musd)
        Ownable(owner_)
    {
        priceFeed = priceFeed_;
        borrowerOpsSigs = borrowerOpsSigs_;
        premiumTable = [
            5736, 4645, 3683, 2857, 2165, 1602, 1155, 811, 554, 368, 237, 148, 90,
            52, 30, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25
        ];
    }

    // ------------------------------------------------------------------ cover

    /// @notice Buy one-touch cover that runs until `expiry`.
    /// @param expiry A weekly expiry (Thursday 00:00 UTC): `currentExpiry()` or up to 3 weeks after it.
    /// @param strike BTC price (18 decimals) that triggers the payout; multiple of STRIKE_STEP.
    /// @param cover MUSD paid out if the price touches `strike` before expiry.
    /// @param maxPremium Reverts if the premium at execution exceeds this (price or vol moved).
    /// @param autoRepay If true, the payout repays the buyer's trove using `signature`, a
    /// RepayMUSD(cover, buyer, nonce, sigDeadline) signature for Mezo's BorrowerOperationsSignatures.
    /// Falls back to a wallet transfer if the repay is no longer valid.
    function buy(
        uint256 expiry,
        uint256 strike,
        uint256 cover,
        uint256 maxPremium,
        bool autoRepay,
        uint256 sigDeadline,
        bytes calldata signature
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        uint256 first = currentExpiry();
        require(expiry % EPOCH == 0 && expiry >= first && expiry < first + MAX_WEEKS * EPOCH, "Payung: bad expiry");
        require(block.timestamp + SALE_CUTOFF < expiry, "Payung: sales closed");
        require(strike > 0 && strike % STRIKE_STEP == 0, "Payung: bad strike");
        require(cover >= MIN_COVER, "Payung: cover too small");
        if (autoRepay) require(sigDeadline >= expiry && signature.length > 0, "Payung: bad repay signature");

        uint256 price = priceFeed.fetchPrice();
        require(strike < price, "Payung: strike above spot");
        uint256 distance = (price - strike) * BPS / price;
        require(distance >= MIN_DISTANCE_BPS && distance <= MAX_DISTANCE_BPS, "Payung: strike out of range");
        _observe(price);

        Strike storage s = strikes[expiry][strike];
        require(!s.triggered, "Payung: strike already touched");
        if (s.cover == 0) {
            require(_strikeList[expiry].length < MAX_STRIKES, "Payung: too many strikes");
            _strikeList[expiry].push(strike);
        }

        uint256 premium =
            Math.mulDiv(cover, premiumRate(price, strike, expiry - block.timestamp), BPS, Math.Rounding.Ceil);
        require(premium <= maxPremium, "Payung: premium moved");
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), premium);
        require(cover <= coverCapacity(), "Payung: vault capacity");

        s.cover += cover;
        lockedCover[expiry] += cover;

        id = _policies.length;
        _policies.push(
            Policy({
                holder: msg.sender,
                expiry: uint64(expiry),
                autoRepay: autoRepay,
                claimed: false,
                strike: strike,
                cover: cover,
                sigDeadline: sigDeadline,
                signature: autoRepay ? signature : bytes("")
            })
        );
        _policiesOf[msg.sender].push(id);
        emit PolicyBought(id, msg.sender, expiry, strike, cover, premium, autoRepay);
    }

    /// @notice Permissionless: mark `strike` of `expiry` as touched once the Mezo price is at or below it.
    /// The caller earns 0.1% of the touched cover (max 10 MUSD) from the vault's free MUSD.
    function trigger(uint256 expiry, uint256 strike) external nonReentrant returns (uint256 reward) {
        require(block.timestamp < expiry, "Payung: epoch over");
        Strike storage s = strikes[expiry][strike];
        require(s.cover > 0 && !s.triggered, "Payung: nothing to trigger");
        uint256 price = priceFeed.fetchPrice();
        require(price <= strike, "Payung: not touched");
        _observe(price);

        s.triggered = true;
        lockedCover[expiry] -= s.cover;
        totalOwed += s.cover;

        reward = Math.min(triggerReward(s.cover), freeLiquidity());
        if (reward > 0) IERC20(asset()).safeTransfer(msg.sender, reward);
        emit StrikeTriggered(expiry, strike, price, s.cover, msg.sender, reward);
    }

    /// @notice Permissionless: pay a policy whose strike was touched. Keepers pass sorted-trove
    /// hints for the repay; zero hints also work, just cost more gas.
    function claim(uint256 id, address upperHint, address lowerHint) external nonReentrant {
        Policy storage p = _policies[id];
        require(!p.claimed, "Payung: already paid");
        require(strikes[p.expiry][p.strike].triggered, "Payung: not triggered");
        p.claimed = true;
        totalOwed -= p.cover;

        if (p.autoRepay && block.timestamp <= p.sigDeadline) {
            require(gasleft() > REPAY_GAS, "Payung: more gas");
            try borrowerOpsSigs.repayMUSDWithSignature(p.cover, upperHint, lowerHint, p.holder, p.signature, p.sigDeadline)
            {
                emit PolicyPaid(id, p.holder, p.cover, true);
                return;
            } catch {
                // Signature used/voided, trove closed, or repay would break min debt: pay the wallet.
            }
        }
        IERC20(asset()).safeTransfer(p.holder, p.cover);
        emit PolicyPaid(id, p.holder, p.cover, false);
    }

    /// @notice Holder re-signs (or turns off) auto-repay, e.g. after another Mezo signature
    /// action used up the nonce the original signature was made with.
    function setAutoRepay(uint256 id, bool autoRepay, uint256 sigDeadline, bytes calldata signature) external {
        Policy storage p = _policies[id];
        require(msg.sender == p.holder, "Payung: not holder");
        require(!p.claimed, "Payung: already paid");
        if (autoRepay) require(sigDeadline >= p.expiry && signature.length > 0, "Payung: bad repay signature");
        p.autoRepay = autoRepay;
        p.sigDeadline = sigDeadline;
        p.signature = autoRepay ? signature : bytes("");
        emit AutoRepayUpdated(id, autoRepay, sigDeadline);
    }

    // ------------------------------------------------------------------ volatility

    /// @notice Permissionless: sample the Mezo price into the on-chain volatility estimate.
    function poke() external {
        require(_observe(priceFeed.fetchPrice()), "Payung: too soon");
    }

    /// @notice Annualised BTC volatility (wad): EWMA of Mezo PriceFeed returns, clamped to [35%, 200%].
    function volatility() public view returns (uint256) {
        return Math.min(Math.max(Math.sqrt(variance * 1e18), VOL_FLOOR), VOL_CAP);
    }

    function _observe(uint256 price) internal returns (bool) {
        uint256 dt = block.timestamp - lastObservedAt;
        if (dt < OBSERVE_INTERVAL) return false;
        uint256 last = lastObservedPrice;
        if (last != 0 && dt <= OBSERVE_MAX_GAP) {
            uint256 move = price > last ? price - last : last - price;
            // (move / last)^2 annualised, in wad, with a single rounding step
            uint256 sample = Math.mulDiv(move * 365 days, move * 1e18, last * last * dt);
            uint256 w = dt * 1e18 / (dt + VOL_TAU); // wad weight of this sample
            // slither-disable-next-line divide-before-multiply (one rounding step on a wad weight)
            variance = (variance * (1e18 - w) + sample * w) / 1e18;
        }
        lastObservedPrice = uint128(price);
        lastObservedAt = uint64(block.timestamp);
        emit VolatilityObserved(price, volatility());
        return true;
    }

    // ------------------------------------------------------------------ pricing

    /// @notice Premium per unit of cover (bps) for `strike` with `remaining` seconds to expiry.
    /// A one-touch probability depends on distance / (vol * sqrt(time)), so the distance is
    /// rescaled onto the one-week, 50%-vol table: cover gets cheaper as the week runs out, dearer
    /// for multi-week terms, and the NAV mark decays smoothly instead of jumping at expiry.
    function premiumRate(uint256 price, uint256 strike, uint256 remaining) public view returns (uint256) {
        if (price <= strike) return BPS;
        // slither-disable-next-line incorrect-equality (expiry reached: nothing left to insure)
        if (remaining == 0) return 0;
        uint256 distance = (price - strike) * BPS / price;
        uint256 timeScale = Math.sqrt(EPOCH * 1e36 / remaining); // sqrt(week / remaining), wad
        return touchProbability(Math.mulDiv(distance, VOL_REF * timeScale, volatility() * 1e18));
    }

    /// @notice Touch probability in bps for a strike `distanceBps` below spot, one week at 50% vol.
    function touchProbability(uint256 distanceBps) public view returns (uint256) {
        if (distanceBps >= MAX_DISTANCE_BPS) return premiumTable[TABLE_SIZE - 1];
        if (distanceBps < MIN_DISTANCE_BPS) {
            // Between spot (certain touch) and the first table point.
            return BPS - (BPS - premiumTable[0]) * distanceBps / MIN_DISTANCE_BPS;
        }
        uint256 i = (distanceBps - MIN_DISTANCE_BPS) / 100;
        // slither-disable-next-line weak-prng (interpolation remainder, not randomness)
        uint256 frac = (distanceBps - MIN_DISTANCE_BPS) % 100;
        uint256 a = premiumTable[i];
        uint256 b = premiumTable[i + 1];
        return a - (a - b) * frac / 100; // table is non-increasing
    }

    /// @notice Premium for `cover` at `strike` until `expiry`, at the current Mezo price and vol.
    function quote(uint256 expiry, uint256 strike, uint256 cover)
        external
        view
        returns (uint256 premium, uint256 distanceBps)
    {
        uint256 price = priceFeed.fetchPrice();
        require(strike < price, "Payung: strike above spot");
        require(expiry > block.timestamp, "Payung: epoch over");
        distanceBps = (price - strike) * BPS / price;
        uint256 remaining = expiry - block.timestamp;
        premium = Math.mulDiv(cover, premiumRate(price, strike, remaining), BPS, Math.Rounding.Ceil);
    }

    function setPremiumTable(uint16[TABLE_SIZE] calldata table) external onlyOwner {
        for (uint256 i; i < TABLE_SIZE; ++i) {
            require(table[i] > 0 && table[i] <= BPS, "Payung: bad entry");
            if (i > 0) require(table[i] <= table[i - 1], "Payung: must be non-increasing");
        }
        premiumTable = table;
        emit PremiumTableUpdated(table);
    }

    /// @notice Caps open cover (all expiries) at `bps` of the vault, bounding what underwriters can lose.
    function setMaxUtilization(uint256 bps) external onlyOwner {
        require(bps > 0 && bps <= BPS, "Payung: bad utilization");
        maxUtilization = bps;
        emit MaxUtilizationUpdated(bps);
    }

    /// @notice Pauses new cover only. Deposits, withdrawals, triggers and claims keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ vault accounting

    /// @notice MUSD held minus what is owed minus the marked value of open cover.
    /// Open cover is marked at the same touch probability used to sell it, so buying
    /// cover is NAV-neutral and depositors cannot front-run premiums or losses.
    function totalAssets() public view override returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 liability = totalOwed + openLiability();
        return balance > liability ? balance - liability : 0;
    }

    /// @notice Marked value of untriggered cover. If the oracle is stale, every open
    /// policy is marked at full cover (conservative for those staying in the vault).
    function openLiability() public view returns (uint256 liability) {
        // slither-disable-next-line uninitialized-local (set in the try branch)
        uint256 price;
        try priceFeed.fetchPrice() returns (uint256 p) {
            price = p;
        } catch {
            return totalLocked();
        }
        uint256 first = currentExpiry();
        for (uint256 w; w < MAX_WEEKS; ++w) {
            uint256 expiry = first + w * EPOCH;
            uint256 remaining = expiry - block.timestamp;
            uint256[] storage list = _strikeList[expiry];
            for (uint256 i; i < list.length; ++i) {
                Strike storage s = strikes[expiry][list[i]];
                if (s.triggered) continue;
                liability += price <= list[i]
                    ? s.cover + triggerReward(s.cover) // touched, the trigger (and its reward) is a call away
                    : Math.mulDiv(s.cover, premiumRate(price, list[i], remaining), BPS, Math.Rounding.Ceil);
            }
        }
    }

    /// @notice Untriggered cover of every live expiry: the collateral locked right now.
    /// Expired weeks drop out by themselves, so nothing needs to roll them over.
    function totalLocked() public view returns (uint256 locked) {
        uint256 first = currentExpiry();
        for (uint256 w; w < MAX_WEEKS; ++w) {
            locked += lockedCover[first + w * EPOCH];
        }
    }

    function triggerReward(uint256 cover) public pure returns (uint256) {
        return Math.min(cover * TRIGGER_REWARD_BPS / BPS, MAX_TRIGGER_REWARD);
    }

    /// @notice MUSD not reserved for payouts or open cover; the only part that can leave or back new cover.
    function freeLiquidity() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 reserved = totalOwed + totalLocked();
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Cover that can still be sold (any expiry) under `maxUtilization`.
    function coverCapacity() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        if (balance <= totalOwed) return 0;
        uint256 cap = (balance - totalOwed) * maxUtilization / BPS;
        uint256 used = totalLocked();
        return cap > used ? cap - used : 0;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), freeLiquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), convertToShares(freeLiquidity()));
    }

    /// @dev Deposits price shares off NAV, so they need a fresh oracle (stale NAV is conservative).
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        // slither-disable-next-line unused-return (called only to revert while the oracle is stale)
        priceFeed.fetchPrice();
        super._deposit(caller, receiver, assets, shares);
    }

    /// @dev Virtual-share offset against the ERC-4626 donation/inflation attack.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------------ views

    function currentExpiry() public view returns (uint256) {
        return (block.timestamp / EPOCH + 1) * EPOCH;
    }

    function policy(uint256 id) external view returns (Policy memory) {
        return _policies[id];
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function policiesOf(address holder) external view returns (uint256[] memory) {
        return _policiesOf[holder];
    }

    function strikeList(uint256 expiry) external view returns (uint256[] memory) {
        return _strikeList[expiry];
    }
}
