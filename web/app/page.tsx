import { getRequestContext } from "../src/server";
import { Dashboard } from "./components/Dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { store, identity } = await getRequestContext();
  const owner = identity.id;

  const [devices, profiles, history, settings] = await Promise.all([
    store.listDevices(owner).catch(() => []),
    store.listWifiProfiles(owner).catch(() => []),
    store.listHistory(owner, { limit: 50 }).catch(() => []),
    store.getSettings(owner).catch(() => ({})),
  ]);

  return (
    <main>
      <Dashboard
        identity={identity}
        initialDevices={devices}
        initialProfiles={profiles}
        initialHistory={history}
        initialSettings={settings}
      />
    </main>
  );
}
