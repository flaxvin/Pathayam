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
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}
