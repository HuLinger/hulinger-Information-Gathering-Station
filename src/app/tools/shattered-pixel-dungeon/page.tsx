import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import DungeonPlayer from '../../../components/tools/DungeonPlayer';
import { AuthError, requireUser } from '../../../server/authorize';

export const dynamic = 'force-dynamic';
export const metadata = { title: '破碎的像素地牢 · Hulinger' };

export default async function DungeonPage() {
  try { await requireUser(await headers()); }
  catch (error) {
    if (error instanceof AuthError) redirect('/login');
    throw error;
  }
  return <DungeonPlayer />;
}
