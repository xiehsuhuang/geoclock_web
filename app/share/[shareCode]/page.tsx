import ShareTripClient from "./ShareTripClient";

export default async function ShareTripPage({
  params
}: {
  params: Promise<{
    shareCode: string;
  }>;
}) {
  const { shareCode } = await params;
  return <ShareTripClient shareCode={shareCode} />;
}
