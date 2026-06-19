import { loadEnv } from "../envcrypt.js";
loadEnv();

import { config } from "../config.js";
import { closePosition } from "../tools/dlmm.js";

const positionId = "BXFT5aHdAzbU2PoBRmLQHia8EYbgV9NWroMVg4C6bfJL";
const result = await closePosition({ position_address: positionId, reason: "duplicate — race condition double deploy" });
console.log(JSON.stringify(result, null, 2));
process.exit(result?.success === false ? 1 : 0);
