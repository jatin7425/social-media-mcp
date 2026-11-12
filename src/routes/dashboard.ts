import { Hono } from "hono";
import dashboardHtml from "../../UI/dashboard.html";

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.get("/dashboard", (c) => c.html(dashboardHtml));
