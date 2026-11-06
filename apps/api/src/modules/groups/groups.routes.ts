import { Router, type Request } from "express";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/requireAuth";
import { requireGroupMember } from "../../middleware/requireGroupMember";
import { requirePermission } from "../../middleware/requirePermission";
import * as groups from "./groups.service";
import * as members from "./members.service";
import * as invitations from "./invitations.service";
import {
  changeRoleSchema,
  createGroupSchema,
  inviteSchema,
  updateGroupSchema,
  type ChangeRoleInput,
  type CreateGroupInput,
  type InviteInput,
  type UpdateGroupInput,
} from "./groups.schema";

const router = Router();
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

// ───────────── routes that don't need group membership ─────────────

router.post("/", requireAuth, validateBody(createGroupSchema), async (req, res) => {
  const group = await groups.createGroup(req.user!, req.body as CreateGroupInput, meta(req));
  res.status(201).json({ group });
});

// One user = at most one group, so this list has 0 or 1 items.
router.get("/", requireAuth, async (req, res) => {
  const group = await groups.getMyGroup(req.user!.id);
  res.json({ groups: group ? [group] : [] });
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ group: await groups.getMyGroup(req.user!.id) });
});

// ───────────── everything below requires: logged in + ACTIVE member of :groupId ─────────────

router.use("/:groupId", requireAuth, requireGroupMember);

router.get("/:groupId", requirePermission("group:view"), async (req, res) => {
  const { groupId, role } = req.membership!;
  res.json({ group: await groups.getGroup(groupId, role) });
});

router.put(
  "/:groupId",
  requirePermission("group:update_settings"),
  validateBody(updateGroupSchema),
  async (req, res) => {
    const { groupId, role } = req.membership!;
    const group = await groups.updateGroup(groupId, req.user!.id, role, req.body as UpdateGroupInput, meta(req));
    res.json({ group });
  }
);

// Invitations (President only)
router.post(
  "/:groupId/invitations",
  requirePermission("invitation:manage"),
  validateBody(inviteSchema),
  async (req, res) => {
    const invitation = await invitations.createInvitation(
      req.membership!.groupId,
      { id: req.user!.id, name: req.user!.name },
      (req.body as InviteInput).email,
      meta(req)
    );
    res.status(201).json({ invitation });
  }
);

router.get("/:groupId/invitations", requirePermission("invitation:manage"), async (req, res) => {
  res.json({ invitations: await invitations.listInvitations(req.membership!.groupId) });
});

router.delete(
  "/:groupId/invitations/:invitationId",
  requirePermission("invitation:manage"),
  async (req, res) => {
    await invitations.cancelInvitation(
      req.membership!.groupId,
      String(req.params.invitationId),
      req.user!.id,
      meta(req)
    );
    res.status(204).end();
  }
);

// Members
router.get("/:groupId/members", requirePermission("group:view"), async (req, res) => {
  const { groupId, role } = req.membership!;
  res.json({ members: await members.listMembers(groupId, role) });
});

router.get("/:groupId/members/:memberId", requirePermission("group:view"), async (req, res) => {
  const { groupId, id, role } = req.membership!;
  const member = await members.getMember(groupId, String(req.params.memberId), { id, role });
  res.json({ member });
});

router.put(
  "/:groupId/members/:memberId/role",
  requirePermission("member:change_role"),
  validateBody(changeRoleSchema),
  async (req, res) => {
    const { groupId, id } = req.membership!;
    const result = await members.changeRole(
      groupId,
      String(req.params.memberId),
      (req.body as ChangeRoleInput).role,
      { userId: req.user!.id, membershipId: id },
      meta(req)
    );
    res.json(result);
  }
);

router.post(
  "/:groupId/members/:memberId/remove",
  requirePermission("member:remove"),
  async (req, res) => {
    await members.removeMember(req.membership!.groupId, String(req.params.memberId), req.user!.id, meta(req));
    res.json({ message: "Member removed." });
  }
);

router.post("/:groupId/leave", requirePermission("group:view"), async (req, res) => {
  const { groupId, id, role } = req.membership!;
  await members.leaveGroup(groupId, { id, role }, req.user!.id, meta(req));
  res.json({ message: "You have left the group." });
});

export default router;
