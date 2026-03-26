import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

// Convex Auth needs HTTP routes for email OTP callbacks
auth.addHttpRoutes(http);

export default http;
