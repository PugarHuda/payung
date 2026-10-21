// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISortedTroves {
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
}

interface ITroveManager {
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}

/// @notice Never deployed: the app runs its creation code in an eth_call (a "deployless read").
/// Walks Mezo's sorted troves from the lowest collateral ratio, where redemptions start, up to
/// the top and returns how many loans and how much MUSD debt stand ahead of `borrower` in that
/// queue, out of all loans and all debt (`ahead` = `total` when the borrower has no open loan).
contract RedemptionQueue {
    constructor(ISortedTroves sorted, ITroveManager troves, address borrower) {
        uint256 ahead;
        uint256 debtAhead;
        uint256 total;
        uint256 totalDebt;
        bool passed;
        for (address id = sorted.getLast(); id != address(0); id = sorted.getPrev(id)) {
            if (id == borrower) passed = true;
            (, uint256 principal, uint256 interest,,,) = troves.getEntireDebtAndColl(id);
            ++total;
            totalDebt += principal + interest;
            if (!passed) (ahead, debtAhead) = (total, totalDebt);
        }
        bytes memory out = abi.encode(ahead, debtAhead, total, totalDebt);
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
