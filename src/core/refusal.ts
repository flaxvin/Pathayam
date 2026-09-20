/**
 * A refusal: an answer, not a fault.
 *
 * The domain says no for good reasons all the time — an account that cannot be
 * private where it sits, a category that still holds money. Thrown as a plain
 * Error, every one of those reached the household as *"Something went wrong on
 * the server"* with a 500, and was recorded on the Health page as a defect.
 * Both are wrong: nothing went wrong, and the sentence explaining why is the
 * one thing the person needed to read.
 *
 * `HttpError` already carries this meaning, but it lives in the HTTP layer and
 * the domain must not depend on it. This is the same idea, in core, and the
 * error hook in `main.ts` maps it to a 422 with its message intact.
 */
export class Refusal extends Error {
  /** Unprocessable: the request was understood and is being declined. */
  readonly status: number = 422;

  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/**
 * The thing a URL names is not there.
 *
 * Also an answer rather than a fault, so it extends Refusal and every place
 * that already treats a Refusal as deliberate treats this one the same way —
 * it just answers 404 instead of 422.
 *
 * It exists because the alternative was costing real money. A plain
 * `throw new Error("That account does not exist.")` reaches the household as
 * *"Something went wrong on the server"* with a 500, and — worse — is recorded
 * as a genuine defect. That is not hypothetical: a single request with a
 * mistyped account id once put a failed check on the health page, the health
 * check reported the instance unhealthy, the platform stopped routing to it,
 * and the public demo was down for twenty-four hours. Somebody guessing a URL
 * must not be able to do that.
 */
export class Missing extends Refusal {
  /** Not found: understood, and there is nothing here to act on. */
  override readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "Missing";
  }
}
