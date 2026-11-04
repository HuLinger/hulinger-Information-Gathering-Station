import HubApp from '../components/HubApp';

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <HubApp initialView={typeof params.view === 'string' ? params.view : 'feed'} initialSection={typeof params.section === 'string' ? params.section : 'favorite'} initialEventId={typeof params.id === 'string' ? params.id : null} initialEntityId={typeof params.entity === 'string' ? params.entity : null} />;
}
