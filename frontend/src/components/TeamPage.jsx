import ProfileCard from "./ProfileCard";
import "./TeamPage.css";

import pfpRight from "../assets png/aiden.png";

export default function TeamPage() {
  return (
    <div className="team-page">
      <div className="team-hero">
        <h1 className="team-title">MEET THE TEAM</h1>
      </div>

      <div className="team-grid team-grid--single">
        <ProfileCard
          avatarUrl={pfpRight}
          name="Aiden"
          twitter="https://x.com/aiden_7788"
          telegram="https://t.me/aiden_7788"
        />
      </div>
    </div>
  );
}
