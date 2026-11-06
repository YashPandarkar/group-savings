import type { GroupRole } from "@prisma/client";

// Tell TypeScript about the fields our middleware adds to every request.
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string };
      membership?: { id: string; groupId: string; role: GroupRole };
    }
  }
}

export {};
