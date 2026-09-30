import { identityPass, type Pass } from "@cutkiller/core";

/** Passe « audio » (loudness, ducking, SFX, fondus aux coupes). Implémentée en phase 5 ; identité d'ici là. */
export const audioPass: Pass = identityPass("audio");
