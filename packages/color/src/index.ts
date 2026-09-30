import { identityPass, type Pass } from "@cutkiller/core";

/** Passe « color » (LUT et égalisation d'exposition entre plans). Implémentée en phase 6 ; identité d'ici là. */
export const colorPass: Pass = identityPass("color");
