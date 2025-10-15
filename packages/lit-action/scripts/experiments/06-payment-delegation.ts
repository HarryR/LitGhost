/**
 * Experiment 06: Payment Delegation with Capacity Credits
 *
 * This script explores how to use payment delegation so your frontend app
 * can invoke Lit Actions without exposing your payment credentials.
 *
 * Goal: Have a payment permit that allows the frontend to:
 * - Invoke a specific Lit Action (and nothing else)
 * - Not require the user to pay
 * - Not expose your payment private key in the frontend
 *
 * What we're testing:
 * - How to create a payer wallet with capacity credits
 * - How to delegate capacity to specific users/addresses
 * - Whether we can restrict delegation to specific Lit Actions
 * - How to embed this authorization in the frontend safely
 *
 * Note: According to docs, payment delegation database might not fully
 * support all the features we need. We'll explore what's possible.
 *
 * Run with: pnpm exp:06
 */

async function main() {
  console.log('=== Experiment 06: Payment Delegation ===\n');

  console.log('⚠️  This experiment requires:');
  console.log('  1. A Lit Relayer API key');
  console.log('  2. Understanding of capacity credits');
  console.log('  3. Possibly a funded wallet for minting capacity credits');
  console.log();

  // Check for API key
  const LIT_RELAYER_API_KEY = process.env.LIT_RELAYER_API_KEY;

  if (!LIT_RELAYER_API_KEY) {
    console.log('❌ LIT_RELAYER_API_KEY not found in environment');
    console.log();
    console.log('To use payment delegation, you need:');
    console.log('  1. Sign up for Lit Relayer API key');
    console.log('  2. Set LIT_RELAYER_API_KEY in your environment');
    console.log();
    console.log('For now, here\'s what the workflow would look like:\n');
    printPaymentDelegationWorkflow();
    return;
  }

  console.log('✓ Lit Relayer API key found');
  console.log();

  // TODO: Implement actual payment delegation setup
  console.log('Step 1: Register payer wallet (not implemented yet)');
  console.log('  This would call: POST /register-payer');
  console.log('  Returns: payerSecretKey (treat like a private key!)');
  console.log();

  console.log('Step 2: Add users as payees (not implemented yet)');
  console.log('  This would call: POST /add-users');
  console.log('  Params: list of Ethereum addresses to delegate capacity to');
  console.log();

  console.log('Step 3: Frontend usage (concept)');
  console.log('  - Frontend generates ephemeral wallet');
  console.log('  - Backend adds ephemeral wallet to payees');
  console.log('  - Frontend uses that wallet for session sigs');
  console.log('  - Capacity credits are spent from your payer wallet');
  console.log();

  console.log('🤔 Open Questions:');
  console.log('  Q: Can we restrict delegation to specific Lit Actions only?');
  console.log('  Q: How do we prevent abuse if we delegate to frontend wallets?');
  console.log('  Q: Can we set spending limits per user?');
  console.log('  Q: How do we revoke delegation?');
  console.log();

  console.log('💡 Potential Approach:');
  console.log('  1. Frontend generates ephemeral wallet on load');
  console.log('  2. Frontend sends wallet address to your backend');
  console.log('  3. Backend validates (rate limit, auth, etc)');
  console.log('  4. Backend delegates capacity to that wallet for limited time');
  console.log('  5. Frontend uses that wallet for session sigs');
  console.log('  6. When invoking Lit Action, capacity is spent from your payer');
  console.log('  7. Backend can revoke delegation after timeout');
  console.log();

  console.log('⚠️  Security Considerations:');
  console.log('  - Users could abuse if delegation is too permissive');
  console.log('  - Need rate limiting on backend delegation endpoint');
  console.log('  - Consider: session-based delegation (expire after N minutes)');
  console.log('  - Consider: usage caps per user/session');
  console.log('  - The payerSecretKey must NEVER be exposed to frontend');
  console.log();

  printPaymentDelegationWorkflow();
}

function printPaymentDelegationWorkflow() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Payment Delegation Workflow (Conceptual)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('📋 Setup Phase (CI/Deployment):');
  console.log('  1. Register payer wallet with Lit Relayer');
  console.log('     → Get payerSecretKey (store in env, never commit)');
  console.log('  2. Mint capacity credits for the payer');
  console.log('  3. Store payerSecretKey securely in backend');
  console.log();

  console.log('🎨 Frontend Flow:');
  console.log('  1. User loads your Telegram Mini App');
  console.log('  2. App generates ephemeral Ethereum wallet');
  console.log('     → const wallet = ethers.Wallet.createRandom()');
  console.log('  3. App requests delegation from your backend');
  console.log('     → POST /api/request-delegation { address: wallet.address }');
  console.log('  4. Backend validates and delegates capacity');
  console.log('  5. App can now use that wallet for Lit Protocol session sigs');
  console.log('  6. When app invokes Lit Action, your payer covers the cost');
  console.log();

  console.log('🔧 Backend API (Conceptual):');
  console.log('  POST /api/request-delegation');
  console.log('    - Validates user (rate limit, auth, etc)');
  console.log('    - Calls Lit Relayer: POST /add-users');
  console.log('    - Uses payerSecretKey from env');
  console.log('    - Delegates capacity to user\'s ephemeral wallet');
  console.log('    - Returns success/failure');
  console.log();

  console.log('🔒 Restricting to Specific Lit Action:');
  console.log('  Problem: Payment delegation might not support action-specific limits');
  console.log('  Workaround:');
  console.log('    - When getting session sigs, specify PKP + Lit Action resource');
  console.log('    - Use LitPKPResource + LitActionResource in resourceAbilityRequests');
  console.log('    - This limits what the session can do');
  console.log('    - But payment delegation might still allow any action...');
  console.log();

  console.log('Alternative Approach (More Control):');
  console.log('  - Don\'t use payment delegation database');
  console.log('  - Instead: Backend generates session sigs server-side');
  console.log('  - Backend uses its own wallet for session sigs');
  console.log('  - Backend can fully control what actions are allowed');
  console.log('  - Frontend receives pre-signed session sigs');
  console.log('  - Trade-off: Backend must be online for every request');
  console.log();

  console.log('📚 Next Steps:');
  console.log('  1. Get Lit Relayer API key');
  console.log('  2. Implement actual payment delegation setup');
  console.log('  3. Test capacity credit minting and delegation');
  console.log('  4. Build backend endpoint for delegation');
  console.log('  5. Test from frontend with ephemeral wallets');
  console.log('  6. Measure costs and set appropriate limits');
  console.log();

  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run the experiment
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
