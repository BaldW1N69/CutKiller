import { identityPass, type Pass } from "@cutkiller/core";

export { type AssembleOptions, assembleEdl } from "./assemble";

/** Passe « cut » (suppression des silences et hésitations, calage sur les beats, J/L cuts, rythme). Implémentée en phase 2 ; identité d'ici là. */
export const cutPass: Pass = identityPass("cut");
