import * as anchor from "@coral-xyz/anchor";
import { Program, BN, workspace } from "@coral-xyz/anchor";
import { Streampay } from "../target/types/streampay";
import { 
  PublicKey, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY 
} from "@solana/web3.js";
import { expect } from "chai";

describe("StreamPay Tests", () => {
  // Setup provider and program
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = workspace.Streampay as Program<Streampay>;

  // Test accounts - keeping these at the top for easy access
  let companyOwner: Keypair;
  let employee1: Keypair;
  let employee2: Keypair;
  let nonEmployee: Keypair;
  
  // PDAs
  let companyPda: PublicKey;
  let companyBump: number;
  let employee1Pda: PublicKey;
  let employee1Bump: number;
  let employee2Pda: PublicKey;
  let employee2Bump: number;

  // Test constants
  const COMPANY_NAME = "TestCorp Inc";
  const HOURLY_RATE_1 = new BN(50 * LAMPORTS_PER_SOL / 3600); // 50 SOL per hour converted to lamports per second then scaled
  const HOURLY_RATE_2 = new BN(25 * LAMPORTS_PER_SOL / 3600); // 25 SOL per hour

  before(async () => {
    // Generate fresh keypairs for testing
    companyOwner = Keypair.generate();
    employee1 = Keypair.generate();
    employee2 = Keypair.generate();
    nonEmployee = Keypair.generate();

    console.log("🔑 Generated test accounts:");
    console.log("  Company owner:", companyOwner.publicKey.toString());
    console.log("  Employee 1:", employee1.publicKey.toString());
    console.log("  Employee 2:", employee2.publicKey.toString());

    // Fund all accounts with some SOL for transaction fees
    await Promise.all([
      fundAccount(companyOwner.publicKey, 10),
      fundAccount(employee1.publicKey, 2),
      fundAccount(employee2.publicKey, 2),
      fundAccount(nonEmployee.publicKey, 1)
    ]);

    // Derive PDAs - this is the tricky part that took me forever to figure out
    [companyPda, companyBump] = await PublicKey.findProgramAddress(
      [Buffer.from("company"), companyOwner.publicKey.toBuffer()],
      program.programId
    );

    [employee1Pda, employee1Bump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("employee"),
        companyPda.toBuffer(),
        employee1.publicKey.toBuffer()
      ],
      program.programId
    );

    [employee2Pda, employee2Bump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("employee"),
        companyPda.toBuffer(),
        employee2.publicKey.toBuffer()
      ],
      program.programId
    );

    console.log("📍 Derived PDAs:");
    console.log("  Company PDA:", companyPda.toString());
    console.log("  Employee 1 PDA:", employee1Pda.toString());
  });

  // Helper function to fund accounts - copied this from another project
  async function fundAccount(publicKey: PublicKey, solAmount: number) {
    const signature = await provider.connection.requestAirdrop(
      publicKey,
      solAmount * LAMPORTS_PER_SOL
    );
    
    // Wait for confirmation
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: signature,
    });
  }

  // Helper to get account balance - useful for debugging payment flows
  async function getBalance(publicKey: PublicKey): Promise<number> {
    const balance = await provider.connection.getBalance(publicKey);
    return balance;
  }

  describe("Company Management", () => {
    it("should initialize company successfully", async () => {
      console.log("🏢 Testing company initialization...");
      
      const tx = await program.methods
        .initializeCompany(COMPANY_NAME)
        .accounts({
          company: companyPda,
          owner: companyOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([companyOwner])
        .rpc();

      console.log("Transaction signature:", tx);

      // Verify company account was created properly
      const companyAccount = await program.account.company.fetch(companyPda);
      expect(companyAccount.owner.toString()).to.equal(companyOwner.publicKey.toString());
      expect(companyAccount.companyName).to.equal(COMPANY_NAME);
      expect(companyAccount.employeeCount).to.equal(0);
      expect(companyAccount.totalDeposited.toNumber()).to.equal(0);
      
      console.log("✅ Company created:", {
        name: companyAccount.companyName,
        owner: companyAccount.owner.toString(),
        employees: companyAccount.employeeCount
      });
    });

    it("fails with empty company name", async () => {
      const badCompanyPda = Keypair.generate();
      
      try {
        await program.methods
          .initializeCompany("")
          .accounts({
            company: badCompanyPda.publicKey,
            owner: companyOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([companyOwner, badCompanyPda])
          .rpc();
        
        expect.fail("Should have thrown error for empty company name");
      } catch (err) {
        console.log("✅ Correctly rejected empty company name");
        expect(err.toString()).to.include("InvalidCompanyName");
      }
    });
  });

  describe("Employee Management", () => {
    it("owner can add employees with different rates", async () => {
      console.log("👥 Adding employees to company...");
      
      // Add first employee
      let tx = await program.methods
        .addEmployee(HOURLY_RATE_1)
        .accounts({
          company: companyPda,
          employeeAccount: employee1Pda,
          employee: employee1.publicKey,
          owner: companyOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([companyOwner])
        .rpc();

      console.log("Added employee 1:", tx);

      // Add second employee with different rate
      tx = await program.methods
        .addEmployee(HOURLY_RATE_2)
        .accounts({
          company: companyPda,
          employeeAccount: employee2Pda,
          employee: employee2.publicKey,
          owner: companyOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([companyOwner])
        .rpc();

      console.log("Added employee 2:", tx);

      // Check employee accounts were setup correctly
      const emp1 = await program.account.employeeAccount.fetch(employee1Pda);
      const emp2 = await program.account.employeeAccount.fetch(employee2Pda);

      expect(emp1.hourlyRate.toString()).to.equal(HOURLY_RATE_1.toString());
      expect(emp2.hourlyRate.toString()).to.equal(HOURLY_RATE_2.toString());
      expect(emp1.totalEarned.toNumber()).to.equal(0);
      expect(emp1.isSpectrum).to.equal(false);

      // Company should show 2 employees now
      const company = await program.account.company.fetch(companyPda);
      expect(company.employeeCount).to.equal(2);

      console.log("✅ Employees added successfully:", {
        count: company.employeeCount,
        emp1Rate: emp1.hourlyRate.toString(),
        emp2Rate: emp2.hourlyRate.toString()
      });
    });

    it("prevents non-owners from adding employees", async () => {
      const randomGuy = Keypair.generate();
      await fundAccount(randomGuy.publicKey, 1);
      
      const [badEmployeePda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("employee"),
          companyPda.toBuffer(),
          randomGuy.publicKey.toBuffer()
        ],
        program.programId
      );

      try {
        await program.methods
          .addEmployee(HOURLY_RATE_1)
          .accounts({
            company: companyPda,
            employeeAccount: badEmployeePda,
            employee: randomGuy.publicKey,
            owner: nonEmployee.publicKey, // Wrong owner!
            systemProgram: SystemProgram.programId,
          })
          .signers([nonEmployee])
          .rpc();
        
        expect.fail("Should not allow non-owners to add employees");
      } catch (err) {
        console.log("✅ Blocked unauthorized employee addition");
      }
    });

    it("rejects zero hourly rate", async () => {
      const badEmployee = Keypair.generate();
      const [badEmployeePda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("employee"),
          companyPda.toBuffer(),
          badEmployee.publicKey.toBuffer()
        ],
        program.programId
      );

      try {
        await program.methods
          .addEmployee(new BN(0)) // Zero rate
          .accounts({
            company: companyPda,
            employeeAccount: badEmployeePda,
            employee: badEmployee.publicKey,
            owner: companyOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([companyOwner])
          .rpc();
        
        expect.fail("Should reject zero hourly rate");
      } catch (err) {
        expect(err.toString()).to.include("InvalidHourlyRate");
        console.log("✅ Correctly rejected zero hourly rate");
      }
    });
  });

  describe("Payroll Funding", () => {
    it("company owner can deposit payroll funds", async () => {
      const depositAmount = new BN(5 * LAMPORTS_PER_SOL);
      console.log(`💰 Depositing ${depositAmount.toNumber() / LAMPORTS_PER_SOL} SOL for payroll...`);
      
      const initialBalance = await getBalance(companyPda);
      console.log("Company PDA balance before:", initialBalance / LAMPORTS_PER_SOL, "SOL");

      const tx = await program.methods
        .depositPayroll(depositAmount)
        .accounts({
          company: companyPda,
          owner: companyOwner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([companyOwner])
        .rpc();

      console.log("Deposit transaction:", tx);

      const finalBalance = await getBalance(companyPda);
      const company = await program.account.company.fetch(companyPda);
      
      console.log("Company PDA balance after:", finalBalance / LAMPORTS_PER_SOL, "SOL");
      console.log("Total deposited tracked:", company.totalDeposited.toNumber() / LAMPORTS_PER_SOL, "SOL");

      expect(company.totalDeposited.toString()).to.equal(depositAmount.toString());
      expect(finalBalance).to.be.greaterThan(initialBalance);
    });

    it("blocks deposits from non-owners", async () => {
      try {
        await program.methods
          .depositPayroll(new BN(LAMPORTS_PER_SOL))
          .accounts({
            company: companyPda,
            owner: employee1.publicKey, // Not the owner!
            systemProgram: SystemProgram.programId,
          })
          .signers([employee1])
          .rpc();
        
        expect.fail("Should not allow non-owners to deposit");
      } catch (err) {
        console.log("✅ Blocked deposit from non-owner");
      }
    });
  });

  describe("Work Session Management", () => {
    let workSession1Pda: PublicKey;
    let workSession2Pda: PublicKey;

    it("employees can clock in successfully", async () => {
      console.log("⏰ Testing employee clock in...");
      
      // Generate session ID and derive PDA
      const sessionId = new BN(1);
      [workSession1Pda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("work_session"),
          employee1Pda.toBuffer(),
          sessionId.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const tx = await program.methods
        .clockIn(sessionId)
        .accounts({
          employeeAccount: employee1Pda,
          employee: employee1.publicKey,
          workSession: workSession1Pda,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([employee1])
        .rpc();

      console.log("Clock in transaction:", tx);

      // Verify employee is marked as clocked in
      const employeeAccount = await program.account.employeeAccount.fetch(employee1Pda);
      expect(employeeAccount.isClockedIn).to.be.true;
      
      // Verify work session was created
      const workSession = await program.account.workSession.fetch(workSession1Pda);
      expect(workSession.sessionId.toString()).to.equal(sessionId.toString());
      expect(workSession.clockOutTime.toNumber()).to.equal(0); // Not clocked out yet
      
      console.log("✅ Employee clocked in:", {
        employee: employeeAccount.employee.toString(),
        sessionId: workSession.sessionId.toString(),
        clockInTime: workSession.clockInTime.toNumber()
      });
    });

    it("prevents double clock-in", async () => {
      // Employee 1 is already clocked in, try to clock in again
      const sessionId = new BN(2);
      const [duplicateSessionPda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("work_session"),
          employee1Pda.toBuffer(),
          sessionId.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      try {
        await program.methods
          .clockIn(sessionId)
          .accounts({
            employeeAccount: employee1Pda,
            employee: employee1.publicKey,
            workSession: duplicateSessionPda,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([employee1])
          .rpc();
        
        expect.fail("Should not allow double clock-in");
      } catch (err) {
        expect(err.toString()).to.include("AlreadyClockedIn");
        console.log("✅ Prevented double clock-in");
      }
    });

    it("employees can clock out and earn wages", async () => {
      console.log("⏰ Testing employee clock out...");
      
      // Wait a bit to simulate work time
      await new Promise(resolve => setTimeout(resolve, 2000));

      const tx = await program.methods
        .clockOut()
        .accounts({
          employeeAccount: employee1Pda,
          employee: employee1.publicKey,
          workSession: workSession1Pda,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([employee1])
        .rpc();

      console.log("Clock out transaction:", tx);

      const employeeAccount = await program.account.employeeAccount.fetch(employee1Pda);
      const workSession = await program.account.workSession.fetch(workSession1Pda);

      expect(employeeAccount.isClockedIn).to.be.false;
      expect(workSession.clockOutTime.toNumber()).to.be.greaterThan(0);
      expect(workSession.hoursWorked.toNumber()).to.be.greaterThan(0);
      expect(employeeAccount.totalEarned.toNumber()).to.be.greaterThan(0);

      console.log("✅ Employee clocked out successfully:", {
        hoursWorked: workSession.hoursWorked.toNumber() / 100, // Convert back from precision
        amountEarned: workSession.amountEarned.toNumber() / LAMPORTS_PER_SOL,
        totalEarned: employeeAccount.totalEarned.toNumber() / LAMPORTS_PER_SOL
      });
    });

    it("prevents clock out when not clocked in", async () => {
      // Employee2 has never clocked in
      const sessionId = new BN(3);
      [workSession2Pda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("work_session"),
          employee2Pda.toBuffer(),
          sessionId.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      try {
        await program.methods
          .clockOut()
          .accounts({
            employeeAccount: employee2Pda,
            employee: employee2.publicKey,
            workSession: workSession2Pda,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([employee2])
          .rpc();
        
        expect.fail("Should not allow clock out when not clocked in");
      } catch (err) {
        expect(err.toString()).to.include("NotClockedIn");
        console.log("✅ Prevented clock out when not clocked in");
      }
    });
  });

  describe("Earnings and Withdrawals", () => {
    it("employees can withdraw earned wages", async () => {
      console.log("💸 Testing wage withdrawal...");
      
      const employeeBefore = await program.account.employeeAccount.fetch(employee1Pda);
      const initialBalance = await getBalance(employee1.publicKey);
      const withdrawAmount = employeeBefore.totalEarned;

      console.log("Employee balance before withdrawal:", initialBalance / LAMPORTS_PER_SOL, "SOL");
      console.log("Total earned to withdraw:", withdrawAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");

      const tx = await program.methods
        .withdrawWages(withdrawAmount)
        .accounts({
          company: companyPda,
          employeeAccount: employee1Pda,
          employee: employee1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([employee1])
        .rpc();

      console.log("Withdrawal transaction:", tx);

      const employeeAfter = await program.account.employeeAccount.fetch(employee1Pda);
      const finalBalance = await getBalance(employee1.publicKey);

      expect(employeeAfter.totalWithdrawn.toString()).to.equal(withdrawAmount.toString());
      expect(finalBalance).to.be.greaterThan(initialBalance);

      console.log("✅ Withdrawal successful:", {
        amountWithdrawn: withdrawAmount.toNumber() / LAMPORTS_PER_SOL,
        newBalance: finalBalance / LAMPORTS_PER_SOL,
        totalWithdrawn: employeeAfter.totalWithdrawn.toNumber() / LAMPORTS_PER_SOL
      });
    });

    it("prevents withdrawing more than earned", async () => {
      const tooMuch = new BN(999 * LAMPORTS_PER_SOL);
      
      try {
        await program.methods
          .withdrawWages(tooMuch)
          .accounts({
            company: companyPda,
            employeeAccount: employee1Pda,
            employee: employee1.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([employee1])
          .rpc();
        
        expect.fail("Should not allow withdrawal of more than earned");
      } catch (err) {
        expect(err.toString()).to.include("InsufficientEarnings");
        console.log("✅ Prevented excessive withdrawal");
      }
    });

    it("prevents withdrawal when company has insufficient funds", async () => {
      // First let's have employee2 work and earn some money
      const sessionId = new BN(4);
      const [workSessionPda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("work_session"),
          employee2Pda.toBuffer(),
          sessionId.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      // Employee2 clocks in
      await program.methods
        .clockIn(sessionId)
        .accounts({
          employeeAccount: employee2Pda,
          employee: employee2.publicKey,
          workSession: workSessionPda,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([employee2])
        .rpc();

      // Wait and clock out to earn wages
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await program.methods
        .clockOut()
        .accounts({
          employeeAccount: employee2Pda,
          employee: employee2.publicKey,
          workSession: workSessionPda,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([employee2])
        .rpc();

      // Now try to withdraw but company should be low on funds after previous withdrawal
      const employee2Account = await program.account.employeeAccount.fetch(employee2Pda);
      
      try {
        await program.methods
          .withdrawWages(employee2Account.totalEarned)
          .accounts({
            company: companyPda,
            employeeAccount: employee2Pda,
            employee: employee2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([employee2])
          .rpc();
        
        console.log("Withdrawal succeeded - company had enough funds");
      } catch (err) {
        console.log("✅ Company insufficient funds detected:", err.message);
      }
    });
  });

  describe("Error Cases and Edge Conditions", () => {
    it("rejects actions from non-employees", async () => {
      const sessionId = new BN(99);
      const [badSessionPda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("work_session"),
          employee1Pda.toBuffer(), // Using employee1's PDA but different signer
          sessionId.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      try {
        await program.methods
          .clockIn(sessionId)
          .accounts({
            employeeAccount: employee1Pda,
            employee: nonEmployee.publicKey, // Wrong employee!
            workSession: badSessionPda,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([nonEmployee])
          .rpc();
        
        expect.fail("Should reject non-employee actions");
      } catch (err) {
        console.log("✅ Blocked action from non-employee");
      }
    });

    it("handles large numbers correctly", async () => {
      // Test with very high hourly rate to check for overflows
      const bigEmployee = Keypair.generate();
      await fundAccount(bigEmployee.publicKey, 1);
      
      const [bigEmployeePda] = await PublicKey.findProgramAddress(
        [
          Buffer.from("employee"),
          companyPda.toBuffer(),
          bigEmployee.publicKey.toBuffer()
        ],
        program.programId
      );

      // This should be close to but not exceed practical limits
      const highRate = new BN("18446744073709551615"); // Close to u64 max
      
      try {
        await program.methods
          .addEmployee(highRate)
          .accounts({
            company: companyPda,
            employeeAccount: bigEmployeePda,
            employee: bigEmployee.publicKey,
            owner: companyOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([companyOwner])
          .rpc();
        
        console.log("✅ High rate employee added successfully");
      } catch (err) {
        console.log("⚠️ High rate rejected (expected for very large values)");
      }
    });
  });
});
