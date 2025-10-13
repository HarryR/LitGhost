// SPDX-License-Identifier: AGPL3.0-only
pragma solidity ^0.8.0;

import {IERC20} from './IERC20.sol';
import {IERC3009} from './IERC3009.sol';

interface IERC20_With_Extensions is IERC20, IERC3009 {}

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

struct Deposit3009 {
    DepositTo to;
    Auth3009 auth;
}

struct OpCounters {
    uint64 opCount;
    uint64 processedOps;
    uint32 userCount;
    uint64 lastProcessedBlock;
}

struct UserInfo {
    uint32 userIndex;
    Leaf leaf;
}

function packLeaf(Leaf memory leaf) pure returns (bytes32) {
    // Manual packing to avoid abi.encodePacked bug with calldata arrays
    bytes32 packed = bytes32(abi.encodePacked(
        leaf.encryptedBalances[0],
        leaf.encryptedBalances[1],
        leaf.encryptedBalances[2],
        leaf.encryptedBalances[3],
        leaf.encryptedBalances[4],
        leaf.encryptedBalances[5],
        leaf.idx,
        leaf.nonce
    ));
    return packed;
}

contract LitGhost {

    uint8 constant internal DECIMALS = 2;

    mapping(uint32 => Leaf) internal m_leaves;

    mapping(bytes32 => uint32) internal m_userIndices;

    OpCounters internal m_counters;

    address internal m_owner;

    IERC20_With_Extensions internal m_token;

    uint256 m_dust;

    mapping(address => uint256) m_failedWithdraw;

    uint8 immutable m_decimals;

    event OpDeposit(uint64 indexed idx, bytes32 randKey, bytes32 toUser, uint32 amount);

    event LeafChange(uint32 indexed idx, bytes32 leaf);

    constructor(IERC20_With_Extensions in_token, address in_owner)
    {
        m_token = in_token;

        m_decimals = in_token.decimals();

        m_owner = in_owner;

        // Initialize userCount to 1, treating user ID 0 as a sentinel value
        // This allows us to distinguish "user doesn't exist" (returns 0) from actual users (>= 1)
        m_counters.userCount = 1;

        // Initialize lastProcessedBlock to deployment block
        // Manager will process deposits starting from the block after deployment
        m_counters.lastProcessedBlock = uint64(block.number);
    }

    function getLeaves(uint32[] calldata leafIndices)
        public view returns (Leaf[] memory leaves)
    {
        uint n = leafIndices.length;

        leaves = new Leaf[](n);

        for( uint i = 0; i < n; i++ )
        {
            leaves[i] = m_leaves[leafIndices[i]];
        }
    }

    function getUserLeaves(bytes32[] calldata encryptedUserIdList)
        public view returns (uint32[] memory userLeafIndices)
    {
        uint n = encryptedUserIdList.length;

        userLeafIndices = new uint32[](n);

        for( uint i = 0; i < n; i++ )
        {
            userLeafIndices[i] = m_userIndices[encryptedUserIdList[i]];
        }
    }

    function decimals ()
        public pure returns (uint8)
    {
        return DECIMALS;
    }

    function getStatus()
        public view returns (OpCounters memory counters, uint256 dust)
    {
        counters = m_counters;

        dust = m_dust;
    }

    function getUserInfo(bytes32 encryptedUserId)
        public view returns (UserInfo memory info)
    {
        info.userIndex = m_userIndices[encryptedUserId];

        if (info.userIndex > 0) {
            uint32 leafIdx = (info.userIndex - 1) / 6;
            info.leaf = m_leaves[leafIdx];
        }
    }

    function getUserInfoBatch(bytes32[] calldata encryptedUserIds)
        public view returns (UserInfo[] memory infos)
    {
        uint n = encryptedUserIds.length;
        infos = new UserInfo[](n);

        for (uint i = 0; i < n; i++) {
            infos[i] = getUserInfo(encryptedUserIds[i]);
        }
    }

    function getUpdateContext(bytes32[] calldata encryptedUserIds)
        public view returns (
            OpCounters memory counters,
            uint256 dust,
            UserInfo[] memory userInfos
        )
    {
        counters = m_counters;
        dust = m_dust;
        userInfos = getUserInfoBatch(encryptedUserIds);
    }

    function _convertToTwoDecimals(uint256 amount, uint8 inputDecimals)
        internal pure returns (uint32 roundedAmount, uint256 dust)
    {
        require(inputDecimals >= DECIMALS, "DECIMALS1!");

        uint8 decimalDiff = inputDecimals - DECIMALS;

        uint256 divisor = 10 ** decimalDiff;

        uint256 rounded = amount / divisor;

        require(rounded <= type(uint32).max, "DECIMALS2!");

        roundedAmount = uint32(rounded);

        dust = amount % divisor;
    }

    function _finishDeposit(DepositTo calldata to, uint256 in_amount)
        internal
    {
        (uint32 leafAmount, uint256 leafDust) = _convertToTwoDecimals(in_amount, m_decimals);

        if( leafDust > 0 )
        {
            m_dust += leafDust;
        }

        emit OpDeposit(m_counters.opCount, to.rand, to.user, leafAmount);

        m_counters.opCount += 1;
    }

    function _safeTransfer(address to, uint256 amount)
        internal returns (bool)
    {
        try m_token.transfer(to, amount) returns (bool success)
        {
            return success;
        }
        catch {
            return false;
        }
    }

    // See `blindUserId` in packages/core/src/crypto.ts to get DepositTo
    // Only user can use ERC-20 deposit to pull their own tokens
    // Any other case must use ERC-3009, which uses receiveWithAuthorization
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

    function depositERC3009(DepositTo calldata to, Auth3009 calldata auth)
        public
    {
        depositERC3009(to, auth, 0);
    }

    // See `blindUserId` in packages/core/src/crypto.ts to get DepositTo
    // callerIncentive lets MEV bots deposit for you
    function depositERC3009(DepositTo calldata to, Auth3009 calldata auth, uint256 callerIncentive)
        public
    {
        require( (auth.value - callerIncentive) > 0, "400!" );

        bytes32 nonce = keccak256(abi.encode(to, callerIncentive));

        uint256 depositAmount = auth.value - callerIncentive;

        uint256 bb = m_token.balanceOf(address(this));

        m_token.receiveWithAuthorization(auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, nonce, auth.sig.v, auth.sig.r, auth.sig.s);

        uint256 ba = m_token.balanceOf(address(this));

        require( (bb + auth.value) == ba, "500!" );

        _finishDeposit(to, depositAmount);

        if( callerIncentive > 0 )
        {
            m_token.transfer(msg.sender, callerIncentive);
        }
    }

    function depositManyERC3009(DepositTo[] calldata to, Auth3009[] calldata auth, uint256[] calldata callerIncentive)
        public
    {
        require( to.length == auth.length, "400.1!" );
        require( auth.length == callerIncentive.length, "400.2!" );

        uint n = to.length;

        for( uint i = 0; i < n; i++ )
        {
            depositERC3009(to[i], auth[i], callerIncentive[i]);
        }
    }
    
    function doUpdate(
        uint64 in_opStart,
        uint64 in_opCount,
        uint64 in_nextBlock,
        Leaf[] calldata in_updates,
        bytes32[] calldata in_newUsers,
        Payout[] calldata in_pay,
        bytes32 in_transcript
    )
        public
    {
        // NOTE: any changes to the transcript also need modifying in packages/core/src/transcript.ts

        require( msg.sender == m_owner, "403" );

        // Load counters into memory
        OpCounters memory counters = m_counters;

        require( counters.processedOps == in_opStart, "Invalid opStart" );

        // Update leaves
        uint256 lc = in_updates.length;
        bytes32 transcript = keccak256(abi.encode(in_opStart, in_opCount, in_nextBlock, lc));
        for( uint256 i = 0; i < lc; i++ )
        {
            Leaf calldata leaf = in_updates[i];
            transcript = keccak256(abi.encode(transcript, m_leaves[leaf.idx], leaf));
            m_leaves[leaf.idx] = leaf;
            emit LeafChange(leaf.idx, packLeaf(leaf));
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
            if (!_safeTransfer(p.toWho, p.amount))
            {
                m_failedWithdraw[p.toWho] += p.amount;
            }
        }

        require( transcript == in_transcript, "500!" );

        // Update counters and save back to storage
        counters.processedOps += in_opCount;
        counters.lastProcessedBlock = in_nextBlock;
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

            if (_safeTransfer(in_to, amount))
            {
                return true;
            }
            
            m_failedWithdraw[msg.sender] = amount;
        }
        return false;
    }

    function collectDust()
        public
    {
        uint256 dust = m_dust;

        if (dust > 0)
        {
            m_dust = 0;

            require(_safeTransfer(m_owner, dust), "Dust transfer failed");
        }
    }
}
