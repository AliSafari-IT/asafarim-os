import { forwardedOrigin } from "@asafarim/app-sdk";
import { handlers } from "@/lib/auth";

// Behind the OS gateway the route handler's own origin isn't the visitor's: see withForwardedOrigin.
export const GET = forwardedOrigin(handlers.GET);
export const POST = forwardedOrigin(handlers.POST);
