# StreamPay

A Solana-based payroll system that lets companies track work hours and pay employees automatically. Built with Anchor framework.

## What it does

StreamPay helps companies manage hourly workers by tracking their work sessions and handling payments on the Solana blockchain. Companies can add employees, set hourly rates, and workers can clock in/out for their shifts. Payments happen automatically based on hours worked.

## Project structure

- `programs/streampay/` - The main Solana program written in Rust
- `tests/` - TypeScript tests for the smart contract
- `migrations/` - Deployment scripts

## Features

- Company registration and management
- Employee onboarding with hourly rates
- Work session tracking (clock in/out)
- Automatic payment calculation
- Real-time balance tracking

## Getting started

Make sure you have Rust, Solana CLI, and Anchor installed first.

Build the program:
```bash
anchor build
```

Run tests:
```bash
anchor test
```

Deploy to devnet:
```bash
anchor deploy --provider.cluster devnet
```

## Development

This project uses Anchor 0.31.1 and targets Solana localnet by default. The main program logic is in `programs/streampay/src/lib.rs`.

Company owners can initialize their company account, add employees with hourly rates, and employees can start/end work sessions. The contract handles all the payment math automatically.
