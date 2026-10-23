// How much of a bill line a return gives back. Pure and exact (BigInt).

export interface LineAmounts {
  taxablePaise: number;
  cgstPaise: number; // = SGST
  igstPaise: number;
}

export interface ReturnAmounts extends LineAmounts {
  sgstPaise: number;
  totalPaise: number;
}

const B_0 = BigInt(0);
const B_2 = BigInt(2);

// a * num / den rounded half up, all >= 0, den > 0.
const scaled = (a: bigint, num: bigint, den: bigint): bigint => (B_2 * a * num + den) / (B_2 * den);

export function returnAmounts(line: LineAmounts, soldMilli: bigint, alreadyMilli: bigint, nowMilli: bigint): ReturnAmounts {
  if (soldMilli <= B_0 || alreadyMilli < B_0 || nowMilli <= B_0) throw new Error("returnAmounts: bad quantities");
  if (alreadyMilli + nowMilli > soldMilli) throw new Error("returnAmounts: more than was sold");
  const part = (amount: number): number => {
    const a = BigInt(amount);
    return Number(scaled(a, alreadyMilli + nowMilli, soldMilli) - scaled(a, alreadyMilli, soldMilli));
  };
  const taxable = part(line.taxablePaise);
  const cgst = part(line.cgstPaise);
  const igst = part(line.igstPaise);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: cgst, igstPaise: igst, totalPaise: taxable + 2 * cgst + igst };
}
