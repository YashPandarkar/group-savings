import { useAuth } from "../../auth/AuthContext";
import { Alert, PageHeader, Spinner } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { useGroup } from "../../lib/queries";
import GroupSettingsCard from "./GroupSettingsCard";
import PasswordCard from "./PasswordCard";
import ProfileCard from "./ProfileCard";

export default function Settings() {
  const { me } = useAuth();
  const group = useGroup();

  return (
    <>
      <PageHeader title="Settings" subtitle="Your account and your group." />
      <div className="space-y-6">
        <ProfileCard />
        <PasswordCard />
        {group.isPending && <Spinner />}
        {group.isError && <Alert kind="error">{errorMessage(group.error)}</Alert>}
        {group.data && <GroupSettingsCard group={group.data} canEdit={me!.membership!.role === "PRESIDENT"} />}
      </div>
    </>
  );
}
