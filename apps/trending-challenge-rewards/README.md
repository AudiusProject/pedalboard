# Trending rewards plugin

Plugin to handle distribution of rewards for trending challenges.

## Run the plugin by itself

```
audius_db_url=... \
run_now=true \
dry_run=true \
npm run dev
```

or make a .env file with the appropriate values and run
```
npm run dev
```

## Slack config

Add the following to your .env file:

```
slack_bot_token=...
slack_signing_secret=...
slack_app_token=...
slack_channel=...
```

## Slack commands

```
/disburse 2024-01-01
/disbursetest 2024-01-01
/trending
```

## Weekly payout budget

Scheduled runs select only the current date's `tt` and `tut` awards. Use the
explicit `/disbursetest YYYY-MM-DD` and `/disburse YYYY-MM-DD` commands to inspect
or retry a particular week. A run validates the entire batch before submitting
any claim and reports total AUDIO, unpaid AUDIO and unpaid award count. The full
20-award schedule totals 11,000 AUDIO; fewer winners require less.

Funding remains manual and separate from the bot. Reconcile confirmed payouts
and the reward token account balance, then fund only the unpaid approved batch
less its existing balance. Do not refill an unexpected shortfall or treat a
retry as a new weekly budget. Investigate unexplained outflows first. This bot
never transfers treasury funds. Keep SOL transaction fees separate.

No Solana program upgrade or signature revocation is provided by these changes.
Old malicious authorizations may still spend a funded reward account. The batch
limit bounds intended payouts, not what the unchanged on-chain program accepts.
