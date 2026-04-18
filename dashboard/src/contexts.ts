import { createContext } from "@lit/context";
import type { SessionService } from "./services/session.service.js";

export const sessionServiceContext =
  createContext<SessionService>("session-service");
