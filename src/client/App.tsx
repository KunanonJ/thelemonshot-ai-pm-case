import { SignInButton } from "@clerk/react";
import { useEffect } from "react";
import { Button, Spinner } from "./components/ui";
import { useResource } from "./lib/api";
import { SignedInGate } from "./lib/auth";
import { matchPath, RouterProvider, useRouter } from "./lib/router";
import { CampaignDetail } from "./pages/CampaignDetail";
import { CampaignsHome } from "./pages/CampaignsHome";
import { Creators } from "./pages/Creators";
import { MatrixHome } from "./pages/MatrixHome";
import { NewBrief } from "./pages/NewBrief";
import { NewCampaign } from "./pages/NewCampaign";
import { NewProposal } from "./pages/NewProposal";
import { NewRmnCampaign } from "./pages/NewRmnCampaign";
import { ProposalDetail } from "./pages/ProposalDetail";
import { ProposalsHome } from "./pages/ProposalsHome";
import { RmnCampaignDetail } from "./pages/RmnCampaignDetail";
import { RmnHome } from "./pages/RmnHome";
import { RunDetail } from "./pages/RunDetail";
import { System } from "./pages/System";
import { TrendDetail } from "./pages/TrendDetail";
import { TrendsHome } from "./pages/TrendsHome";
import type { Role } from "./types";

export function App() {
  return (
    <SignedInGate
      signedOut={<SignedOut />}
      signedIn={
        <RouterProvider>
          <SignedIn />
        </RouterProvider>
      }
    />
  );
}

function SignedOut() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-8 text-center">
        <span className="mx-auto block h-6 w-6 rounded-full bg-[#f4e04d] ring-1 ring-black/10" />
        <h1 className="mt-4 text-base font-semibold">Lemon Shot AI Suite</h1>
        <p className="mt-1 text-[13px] text-neutral-500">Creator selection, proposals and campaign insight on one data spine.</p>
        <SignInButton mode="modal">
          <Button variant="primary" className="mt-6 w-full">
            Sign in
          </Button>
        </SignInButton>
        <p className="mt-4 text-xs text-neutral-400">Demo build. Creator data shown inside is sample data.</p>
      </div>
    </div>
  );
}

function SignedIn() {
  const me = useResource<{ userId: string; role: Role }>("/api/me");
  const { path, navigate } = useRouter();

  useEffect(() => {
    if (path === "/") navigate("/matrix");
  }, [path, navigate]);

  if (!me.data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">
        {me.error ? `Couldn't load your account (${me.error}).` : <Spinner />}
      </div>
    );
  }
  const { role, userId } = me.data;
  const run = matchPath("/matrix/runs/:id", path);
  const proposal = matchPath("/proposals/:id", path);
  const campaign = matchPath("/campaigns/:id", path);

  if (path === "/matrix/new" && role !== "viewer") return <NewBrief role={role} />;
  if (run) return <RunDetail role={role} id={run.id!} userId={userId} />;
  if (path === "/proposals") return <ProposalsHome role={role} />;
  if (path === "/proposals/new" && role !== "viewer") return <NewProposal role={role} />;
  if (proposal && proposal.id !== "new") return <ProposalDetail role={role} id={proposal.id!} userId={userId} />;
  if (path === "/campaigns") return <CampaignsHome role={role} />;
  if (path === "/campaigns/new" && role !== "viewer") return <NewCampaign role={role} />;
  if (campaign && campaign.id !== "new") return <CampaignDetail role={role} id={campaign.id!} userId={userId} />;
  if (path === "/rmn") return <RmnHome role={role} />;
  if (path === "/rmn/new" && role !== "viewer") return <NewRmnCampaign role={role} />;
  const rmnCampaign = matchPath("/rmn/:id", path);
  if (rmnCampaign && rmnCampaign.id !== "new") return <RmnCampaignDetail role={role} id={rmnCampaign.id!} />;
  if (path === "/creators") return <Creators role={role} />;
  if (path === "/system" && role === "admin") return <System role={role} />;
  if (path === "/trends") return <TrendsHome role={role} />;
  const trend = matchPath("/trends/:id", path);
  if (trend) return <TrendDetail role={role} id={trend.id!} />;
  return <MatrixHome role={role} />;
}
