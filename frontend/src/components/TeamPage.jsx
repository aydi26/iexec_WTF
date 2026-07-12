import ProfileCard from "./ProfileCard";
import "./TeamPage.css";

import pfpLeft from "../assets png/pfp card left.png";
import pfpRight from "../assets png/pfp card right.png";

export default function TeamPage() {
  return (
    <div className="team-page">
      <div className="team-hero">
        <h1 className="team-title">MEET THE TEAM</h1>
      </div>

      <div className="team-grid">
        <ProfileCard
          avatarUrl={pfpLeft}
          name="skar88"
          twitter="https://x.com/0xhaizeka"
          linkedin="https://www.linkedin.com/in/albanderouin/"
          telegram="https://t.me/haizeka88"
        />
        <ProfileCard
          avatarUrl={pfpRight}
          name="Aiden"
          twitter="https://x.com/aiden_7788"
          linkedin="https://www.linkedin.com/in/adrian-verdes/"
          telegram="https://t.me/aiden_7788"
        />
      </div>
    </div>
  );
}
