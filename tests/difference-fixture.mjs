import { pairedFixture } from "./modern-fixture.mjs";

export function differenceFixture({ mixed = false, orientation = "a_minus_b" } = {}) {
  const data = pairedFixture();
  data.provenance.title = "Synthetic difference lens";
  data.views = { ...(mixed ? data.views : {}), difference_vectors: {
    role: "response_difference", orientation, activation_polarity: "signed", code_semantics: "numerical_activity",
    values: [[2, -1], [0, 3], [-4, 0]],
  } };
  return data;
}
