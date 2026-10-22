/**
 * IMPORT-1 · Fictional exports from YNAB and Actual Budget. Every account,
 * payee and figure is made up.
 */

const YNAB_HEADER =
  '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';

/**
 * Day-first (a 14th and a 20th prove it), with a starting balance, a transfer
 * whose both legs are in the file, a three-way split, a category with no
 * envelope of its name, and new money.
 */
export const YNAB_DAY_FIRST = [
  YNAB_HEADER,
  '"ZZ Savings","","01/09/2026","Starting Balance","Inflow: Ready to Assign","Inflow","Ready to Assign","","₹0.00","₹50,000.00","Reconciled"',
  '"ZZ Savings","","02/09/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","weekly shop","₹1,250.50","₹0.00","Cleared"',
  '"ZZ Savings","","05/09/2026","Transfer : ZZ Card","","","","card bill","₹5,000.00","₹0.00","Cleared"',
  '"ZZ Card","","05/09/2026","Transfer : ZZ Savings","","","","card bill","₹0.00","₹5,000.00","Cleared"',
  '"ZZ Card","","14/09/2026","ZZ Supermart","Everyday: Groceries","Everyday","Groceries","Split (1/3) veg","₹600.00","₹0.00","Uncleared"',
  '"ZZ Card","","14/09/2026","ZZ Supermart","Home: Cleaning","Home","Cleaning","Split (2/3) soap","₹250.00","₹0.00","Uncleared"',
  '"ZZ Card","","14/09/2026","ZZ Supermart","Fun: Toys","Fun","Toys","Split (3/3) kite","₹150.00","₹0.00","Uncleared"',
  '"ZZ Savings","","20/09/2026","ZZ Gym","Health: Gym","Health","Gym","","₹900.00","₹0.00","Cleared"',
  '"ZZ Savings","","30/09/2026","ZZ Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","salary","₹0.00","₹80,000.00","Cleared"',
].join("\n");

/** Month-first: 09/14 and 09/20 prove it. */
export const YNAB_MONTH_FIRST = [
  YNAB_HEADER,
  '"ZZ Savings","","09/02/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","$12.50","$0.00","Cleared"',
  '"ZZ Savings","","09/14/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","$1,234.00","$0.00","Cleared"',
  '"ZZ Savings","","09/20/2026","ZZ Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$100.00","Cleared"',
].join("\n");

/** Every day 12 or under: 03/04 could be 3 April or 4 March. */
export const YNAB_AMBIGUOUS = [
  YNAB_HEADER,
  '"ZZ Savings","","03/04/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","₹100.00","₹0.00","Cleared"',
  '"ZZ Savings","","05/06/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","₹200.00","₹0.00","Cleared"',
].join("\n");

/** 13/09 and 09/14 in one column: both orders proved, neither usable. */
export const YNAB_MIXED = [
  YNAB_HEADER,
  '"ZZ Savings","","13/09/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","₹100.00","₹0.00","Cleared"',
  '"ZZ Savings","","09/14/2026","ZZ Kirana","Everyday: Groceries","Everyday","Groceries","","₹200.00","₹0.00","Cleared"',
].join("\n");

/** Euro-style numbers: a decimal comma and dot grouping. */
export const YNAB_DECIMAL_COMMA = [
  YNAB_HEADER,
  '"ZZ Savings","","2026-09-02","ZZ Bakery","Everyday: Groceries","Everyday","Groceries","","1.234,56 €","0,00 €","Cleared"',
].join("\n");

/** Actual Budget [unverified column names]: ISO dates, one signed amount, a split. */
export const ACTUAL_EXPORT = [
  "Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared,Reconciled",
  "ZZ Savings,2026-09-02,ZZ Kirana,weekly shop,Groceries,-1250.50,0,true,false",
  "ZZ Savings,2026-09-05,ZZ Card,card bill,,-5000.00,0,true,false",
  "ZZ Card,2026-09-05,ZZ Savings,card bill,,5000.00,0,true,false",
  "ZZ Card,2026-09-14,ZZ Supermart,,,-850.00,0,false,false",
  "ZZ Card,2026-09-14,ZZ Supermart,veg,Groceries,0,-600.00,false,false",
  "ZZ Card,2026-09-14,ZZ Supermart,soap,Cleaning,0,-250.00,false,false",
  "ZZ Savings,2026-09-30,ZZ Employer,salary,,80000.00,0,true,false",
].join("\n");
