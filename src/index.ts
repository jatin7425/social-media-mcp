import { Hono } from "hono";
import { dashboardRoutes } from "./routes/dashboard";
import { devRoutes } from "./routes/dev";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Social Media MCP"));
app.route("/", dashboardRoutes);
app.route("/", devRoutes);

export default app;
