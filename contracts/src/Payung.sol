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
/// @notice Underwriters deposit MUSD into this ERC-4626 vault. Borrowers buy weekly
/// one-touch cover: if the Mezo BTC price touches the strike before expiry
/// (Thursday 00:00 UTC, the Mezo Earn epoch boundary), the cover pays a fixed MUSD
/// amount, either straight into the borrower's trove (pre-signed repay) or to their wallet.
/// Every policy is fully collateralised: the vault never sells more cover than it holds.
contract Payung is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCH = 1 weeks; // unix 0 was a Thursday 00:00 UTC
    uint256 public constant SALE_CUTOFF = 1 hours; // no sales in the last hour of an epoch
    uint256 public constant STRIKE_STEP = 1000e18; // strikes on a $1,000 grid
    uint256 public constant MIN_DISTANCE_BPS = 500; // strike at least 5% below spot
    uint256 public constant MAX_DISTANCE_BPS = 3000; // and at most 30% below
    uint256 public constant MAX_STRIKES = 64; // per epoch: more than the 5-30% band can reach, bounds the NAV loop
    uint256 public constant MIN_COVER = 10e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant TABLE_SIZE = 26; // one entry per 1% from 5% to 30%
    // Leaves room for the repay so a keeper cannot starve it into the fallback path.
    uint256 public constant REPAY_GAS = 800_000;

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

    uint256 public activeExpiry;
    uint256 public activeCover; // untriggered cover of the active epoch (locked collateral)
    uint256 public totalOwed; // triggered cover not yet paid out

    event PolicyBought(
        uint256 indexed id, address indexed holder, uint256 expiry, uint256 strike, uint256 cover, uint256 premium, bool autoRepay
    );
    event StrikeTriggered(uint256 indexed expiry, uint256 indexed strike, uint256 price, uint256 cover);
    event PolicyPaid(uint256 indexed id, address indexed holder, uint256 cover, bool repaidTrove);
    event PremiumTableUpdated(uint16[TABLE_SIZE] table);

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

    /// @notice Buy one-touch cover for the current epoch.
    /// @param strike BTC price (18 decimals) that triggers the payout; multiple of STRIKE_STEP.
    /// @param cover MUSD paid out if the price touches `strike` before expiry.
    /// @param autoRepay If true, the payout repays the buyer's trove using `signature`, a
    /// RepayMUSD(cover, buyer, nonce, sigDeadline) signature for Mezo's BorrowerOperationsSignatures.
    /// Falls back to a wallet transfer if the repay is no longer valid.
    function buy(uint256 strike, uint256 cover, bool autoRepay, uint256 sigDeadline, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        uint256 expiry = currentExpiry();
        require(block.timestamp + SALE_CUTOFF < expiry, "Payung: sales closed");
        require(strike > 0 && strike % STRIKE_STEP == 0, "Payung: bad strike");
        require(cover >= MIN_COVER, "Payung: cover too small");
        if (autoRepay) require(sigDeadline >= expiry && signature.length > 0, "Payung: bad repay signature");

        uint256 price = priceFeed.fetchPrice();
        require(strike < price, "Payung: strike above spot");
        uint256 distance = (price - strike) * BPS / price;
        require(distance >= MIN_DISTANCE_BPS && distance <= MAX_DISTANCE_BPS, "Payung: strike out of range");

        if (activeExpiry != expiry) {
            // Previous epoch is over (sales stop before expiry), so its untriggered cover is void.
            activeExpiry = expiry;
            activeCover = 0;
        }

        Strike storage s = strikes[expiry][strike];
        require(!s.triggered, "Payung: strike already touched");
        if (s.cover == 0) {
            require(_strikeList[expiry].length < MAX_STRIKES, "Payung: too many strikes");
            _strikeList[expiry].push(strike);
        }

        uint256 premium = Math.mulDiv(cover, touchProbability(distance), BPS, Math.Rounding.Ceil);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), premium);
        require(freeLiquidity() >= cover, "Payung: vault capacity");

        s.cover += cover;
        activeCover += cover;

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

    /// @notice Permissionless: mark `strike` as touched once the Mezo price is at or below it.
    function trigger(uint256 strike) external {
        uint256 expiry = activeExpiry;
        require(block.timestamp < expiry, "Payung: epoch over");
        Strike storage s = strikes[expiry][strike];
        require(s.cover > 0 && !s.triggered, "Payung: nothing to trigger");
        uint256 price = priceFeed.fetchPrice();
        require(price <= strike, "Payung: not touched");

        s.triggered = true;
        activeCover -= s.cover;
        totalOwed += s.cover;
        emit StrikeTriggered(expiry, strike, price, s.cover);
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

    // ------------------------------------------------------------------ pricing

    /// @notice Touch probability in bps (premium per unit of cover) for a strike `distanceBps` below spot.
    function touchProbability(uint256 distanceBps) public view returns (uint256) {
        if (distanceBps >= MAX_DISTANCE_BPS) return premiumTable[TABLE_SIZE - 1];
        if (distanceBps < MIN_DISTANCE_BPS) {
            // Between spot (certain touch) and the first table point.
            return BPS - (BPS - premiumTable[0]) * distanceBps / MIN_DISTANCE_BPS;
        }
        uint256 i = (distanceBps - MIN_DISTANCE_BPS) / 100;
        uint256 frac = (distanceBps - MIN_DISTANCE_BPS) % 100;
        uint256 a = premiumTable[i];
        uint256 b = premiumTable[i + 1];
        return a - (a - b) * frac / 100; // table is non-increasing
    }

    /// @notice Premium for `cover` at `strike`, at the current Mezo price.
    function quote(uint256 strike, uint256 cover) external view returns (uint256 premium, uint256 distanceBps) {
        uint256 price = priceFeed.fetchPrice();
        require(strike < price, "Payung: strike above spot");
        distanceBps = (price - strike) * BPS / price;
        premium = Math.mulDiv(cover, touchProbability(distanceBps), BPS, Math.Rounding.Ceil);
    }

    function setPremiumTable(uint16[TABLE_SIZE] calldata table) external onlyOwner {
        for (uint256 i; i < TABLE_SIZE; ++i) {
            require(table[i] > 0 && table[i] <= BPS, "Payung: bad entry");
            if (i > 0) require(table[i] <= table[i - 1], "Payung: must be non-increasing");
        }
        premiumTable = table;
        emit PremiumTableUpdated(table);
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
        if (block.timestamp >= activeExpiry) return 0;
        uint256 price;
        try priceFeed.fetchPrice() returns (uint256 p) {
            price = p;
        } catch {
            return activeCover;
        }
        uint256[] storage list = _strikeList[activeExpiry];
        for (uint256 i; i < list.length; ++i) {
            Strike storage s = strikes[activeExpiry][list[i]];
            if (s.triggered) continue;
            if (price <= list[i]) {
                liability += s.cover;
            } else {
                uint256 distance = (price - list[i]) * BPS / price;
                liability += Math.mulDiv(s.cover, touchProbability(distance), BPS, Math.Rounding.Ceil);
            }
        }
    }

    /// @notice MUSD not reserved for payouts or open cover; the only part that can leave or back new cover.
    function freeLiquidity() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 reserved = totalOwed + (block.timestamp < activeExpiry ? activeCover : 0);
        return balance > reserved ? balance - reserved : 0;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), freeLiquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), convertToShares(freeLiquidity()));
    }

    /// @dev Deposits price shares off NAV, so they need a fresh oracle (stale NAV is conservative).
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
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
