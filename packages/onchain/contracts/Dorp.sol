// SPDX-License-Identifier: AGPL3.0-only
pragma solidity ^0.8.0;

import {IERC20} from './IERC20.sol';
import {IERC2612} from './IERC2612.sol';
import {IERC3009} from './IERC3009.sol';

interface IERC20_With_Extensions is IERC20, IERC2612, IERC3009 {}

struct Leaf {
    bytes4[6] encryptedBalances;
    uint32 idx;
    uint32 nonce;
}

struct Signature {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct Permit2612 {
    address owner;
    uint256 value;
    uint256 deadline;
    Signature sig;
}

struct DepositTo {
    bytes32 rand;
    bytes32 user;
}

struct Auth3009 {
    address from;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    Signature sig;
}

struct Payout {
    address toWho;
    uint256 amount;
}

struct Deposit2612 {
    DepositTo to;
    Permit2612 permit;
}

struct Deposit3009 {
    DepositTo to;
    Auth3009 auth;
}

struct OpCounters {
    uint64 opCount;
    uint64 processedOps;
    uint32 userCount;
}

contract Dorp {

    mapping(uint32 => Leaf) internal m_leaves;

    mapping(bytes32 => uint32) internal m_userIndices;

    OpCounters internal m_counters;

    address internal m_owner;

    IERC20_With_Extensions internal m_token;

    uint256 m_dust;

    mapping(address => uint256) m_failedWithdraw;

    uint8 immutable m_decimals;

    event OpDeposit(uint64 indexed idx, bytes32 randKey, bytes32 toUser, uint32 amount);

    constructor(IERC20_With_Extensions in_token, address in_owner)
    {
        m_token = in_token;

        m_decimals = in_token.decimals();

        m_owner = in_owner;
    }

    function getStatus()
        public view returns (uint64 opCount, uint64 processedOps)
    {
        opCount = m_counters.opCount;

        processedOps = m_counters.processedOps;
    }

    function _convertToTwoDecimals(uint256 amount, uint8 inputDecimals)
        internal pure returns (uint32 roundedAmount, uint256 dust)
    {
        require(inputDecimals >= 2, "Input decimals must be >= 2");
        uint8 decimalDiff = inputDecimals - 2;
        uint256 divisor = 10 ** decimalDiff;
        uint256 rounded = amount / divisor;
        require(rounded <= type(uint32).max, "Amount exceeds uint32 max");        
        roundedAmount = uint32(rounded);
        dust = amount % divisor;
    }

    function _finishDeposit(DepositTo calldata to, uint256 in_amount)
        internal
    {
        (uint32 leafAmount, uint256 leafDust) = _convertToTwoDecimals(in_amount, m_decimals);

        if( leafDust > 0 ) {
            m_dust += leafDust;
        }

        emit OpDeposit(m_counters.opCount, to.rand, to.user, leafAmount);

        m_counters.opCount += 1;
    }

    function _safeTransfer(address to, uint256 amount)
        internal returns (bool)
    {
        try m_token.transfer(to, amount) returns (bool success) {
            return success;
        } catch {
            return false;
        }
    }

    function depositERC20(DepositTo calldata to, uint256 in_amount)
        public
    {
        _depositFromERC20(to, in_amount, msg.sender);
    }

    function _depositFromERC20(DepositTo calldata to, uint256 in_amount, address in_from)
        internal
    {
        uint256 bb = m_token.balanceOf(address(this));

        m_token.transferFrom(in_from, address(this), in_amount);

        uint256 ba = m_token.balanceOf(address(this));

        require( (bb + in_amount) == ba, "500!" );

        _finishDeposit(to, in_amount);
    }

    function depositERC2612(DepositTo calldata to, Permit2612 calldata permit)
        public
    {
        if( m_token.allowance(permit.owner, address(this)) < permit.value )
        {
            m_token.permit(permit.owner, address(this), permit.value, permit.deadline, permit.sig.v, permit.sig.r, permit.sig.s);
        }

        _depositFromERC20(to, permit.value, permit.owner);
    }

    function depositERC3009(DepositTo calldata to, Auth3009 calldata auth)
        public
    {
        bytes32 nonce = keccak256(abi.encode(to));

        uint256 bb = m_token.balanceOf(address(this));

        m_token.transferWithAuthorization(auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, nonce, auth.sig.v, auth.sig.r, auth.sig.s);

        uint256 ba = m_token.balanceOf(address(this));

        require( (bb + auth.value) == ba, "500!" );

        _finishDeposit(to, auth.value);
    }

    function doUpdate(
        uint64 in_opStart,
        uint64 in_opCount,
        Leaf[] calldata in_updates,
        bytes32[] calldata in_newUsers,
        Payout[] calldata in_pay,
        bytes32 in_transcript
    )
        public
    {
        require( msg.sender == m_owner, "403" );

        // Load counters into memory
        OpCounters memory counters = m_counters;

        require( counters.processedOps == in_opStart, "Invalid opStart" );

        // Update leaves
        uint256 lc = in_updates.length;
        bytes32 transcript = keccak256(abi.encode(in_opStart, in_opCount, lc));
        for( uint256 i = 0; i < lc; i++ ) {
            Leaf calldata leaf = in_updates[i];
            transcript = keccak256(abi.encode(transcript, m_leaves[leaf.idx], leaf));
            m_leaves[leaf.idx] = leaf;
        }

        // Insert new users
        uint32 nul = uint32(in_newUsers.length);
        uint32 uc = counters.userCount;
        transcript = keccak256(abi.encode(transcript, uc, nul));
        for( uint32 i = 0; i < nul; i++ )
        {
            uint32 nui = uc+i;
            transcript = keccak256(abi.encode(transcript, nui, in_newUsers[i]));
            m_userIndices[in_newUsers[i]] = nui;
        }
        counters.userCount += nul;

        // Perform payouts
        uint256 pc = in_pay.length;
        transcript = keccak256(abi.encode(transcript, pc));
        for( uint256 i = 0; i < pc; i++ )
        {
            Payout calldata p = in_pay[i];
            transcript = keccak256(abi.encode(transcript, p));
            // Failure paranoia, anything fails, just say we tried our best, owner can fetch it later
            if (!_safeTransfer(p.toWho, p.amount)) {
                m_failedWithdraw[p.toWho] += p.amount;
            }
        }

        require( transcript == in_transcript, "500!" );

        // Increment processedOps and save counters back to storage
        counters.processedOps += in_opCount;
        m_counters = counters;
    }

    // NOTE: because the ERC20 token may not do the transfer (if it's centralized trash)
    // Owner decides who to send funds to, it's their choice
    function handleFailedWithdraw(address in_to)
        public returns (bool)
    {
        uint amount = m_failedWithdraw[msg.sender];

        if( amount > 0 )
        {
            m_failedWithdraw[msg.sender] = 0;
            if (_safeTransfer(in_to, amount)) {
                return true;
            } else {
                m_failedWithdraw[msg.sender] = amount;
            }
        }
        return false;
    }

    function collectDust()
        public
    {
        uint256 dust = m_dust;
        if (dust > 0) {
            m_dust = 0;
            require(_safeTransfer(m_owner, dust), "Dust transfer failed");
        }
    }
}
