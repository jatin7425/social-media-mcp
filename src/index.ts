import { Hono } from "hono";
import { connectRoutes } from "./routes/connect";
import { dashboardRoutes } from "./routes/dashboard";
import { devRoutes } from "./routes/dev";
import { legalRoutes } from "./routes/legal";
import { mcpRoutes } from "./routes/mcp";

const app = new Hono<{ Bindings: Env }>();

app.route("/", legalRoutes);
app.route("/", dashboardRoutes);
app.route("/", devRoutes);
app.route("/", connectRoutes);
app.route("/", mcpRoutes);

export default app;
