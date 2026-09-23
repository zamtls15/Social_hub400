import { Inngest } from "inngest";
import { getConfig } from "../lib/config.js";

const config = getConfig();

export const inngest = new Inngest({
  id: "social-hub",
  name: "Social Hub",
  eventKey: config.inngestEventKey,
});
