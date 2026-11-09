import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { bearer, makeUser } from "./groupHelpers";

const make = (userId: string, title: string, read = false) =>
  prisma.notification.create({
    data: { userId, type: "TEST", title, body: "Body text", readAt: read ? new Date() : null },
  });
const list = (token: string, qs = "") => request(app).get(`/api/notifications${qs}`).set(bearer(token));

describe("notifications", () => {
  it("lists only your own, newest first, with the unread count", async () => {
    const me = await makeUser();
    const other = await makeUser();
    await make(me.id, "First");
    await make(me.id, "Second", true);
    await make(other.id, "Not yours");

    const res = await list(me.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.unread).toBe(1);
    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual(["Second", "First"]);
    expect((await list(me.token, "?unread=true")).body.total).toBe(1);
    expect((await request(app).get("/api/notifications/unread-count").set(bearer(me.token))).body.unread).toBe(1);
  });

  it("marks one as read (repeating is harmless) and refuses someone else's", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const mine = await make(me.id, "Mine");
    const theirs = await make(other.id, "Theirs");
    const read = (token: string, id: string) => request(app).post(`/api/notifications/${id}/read`).set(bearer(token));

    expect((await read(me.token, mine.id)).body.unread).toBe(0);
    expect((await read(me.token, mine.id)).status).toBe(200);
    expect((await read(me.token, theirs.id)).status).toBe(404);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();
    expect((await read(me.token, "does-not-exist")).status).toBe(404);
  });

  it("read-all affects only your own", async () => {
    const me = await makeUser();
    const other = await makeUser();
    await make(me.id, "A");
    await make(me.id, "B");
    await make(other.id, "C");
    const res = await request(app).post("/api/notifications/read-all").set(bearer(me.token));
    expect(res.body.updated).toBe(2);
    expect((await list(me.token)).body.unread).toBe(0);
    expect((await list(other.token)).body.unread).toBe(1);
  });

  it("paginates and validates", async () => {
    const me = await makeUser();
    for (let i = 0; i < 3; i++) await make(me.id, `N${i}`);
    expect((await list(me.token, "?pageSize=2")).body.items).toHaveLength(2);
    expect((await list(me.token, "?pageSize=2&page=2")).body.items).toHaveLength(1);
    expect((await list(me.token, "?pageSize=1000")).status).toBe(400);
    expect((await list(me.token, "?unread=maybe")).status).toBe(400);
  });

  it("requires login", async () => {
    expect((await request(app).get("/api/notifications")).status).toBe(401);
    expect((await request(app).post("/api/notifications/read-all")).status).toBe(401);
  });
});
