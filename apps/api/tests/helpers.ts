import request from "supertest";
import type { Response } from "supertest";
import { createApp } from "../src/app";
import { outbox } from "../src/lib/mailer";

export const app = createApp();
export const PASSWORD = "CorrectHorse42";

let counter = 0;
export const uniqueEmail = () => `user${Date.now()}${++counter}@test.local`;

// Finds the token inside the most recent "sent" email to this address.
export function lastTokenFor(email: string): string | undefined {
  const mail = [...outbox].reverse().find((m) => m.to === email);
  return mail?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
}

export const refreshCookieOf = (res: Response): string =>
  (res.headers["set-cookie"] as unknown as string[])
    .find((c) => c.startsWith("rt="))!
    .split(";")[0];

export async function registerVerified(email = uniqueEmail()) {
  await request(app)
    .post("/api/auth/register")
    .send({ name: "Test User", email, password: PASSWORD })
    .expect(202);
  await request(app)
    .post("/api/auth/verify-email")
    .send({ token: lastTokenFor(email) })
    .expect(200);
  return email;
}

export async function login(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  return {
    accessToken: res.body.accessToken as string,
    userId: res.body.user.id as string,
    refreshCookie: refreshCookieOf(res),
  };
}
