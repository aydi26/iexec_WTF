import './ProfileCard.css';

const TwitterIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M13.6823 10.6218L20.2391 3H18.6854L12.9921 9.61788L8.44486 3L3.2002 3L10.0765 13.0074L3.2002 21H4.75404L10.7663 14.0113L15.5685 21H20.8132L13.6819 10.6218H13.6823ZM11.5541 13.0956L10.8574 12.0991L5.31391 4.16971H7.70053L12.1742 10.5689L12.8709 11.5655L18.6861 19.8835H16.2995L11.5541 13.096V13.0956Z" />
  </svg>
);

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
  </svg>
);

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM16.64 8.8C16.49 10.38 15.84 14.22 15.51 15.99C15.37 16.74 15.09 16.99 14.83 17.02C14.25 17.07 13.81 16.64 13.25 16.27C12.37 15.69 11.87 15.33 11.02 14.77C10.03 14.12 10.67 13.76 11.24 13.18C11.39 13.03 13.95 10.7 14 10.49C14.0069 10.4582 14.006 10.4252 13.9973 10.3938C13.9886 10.3624 13.9724 10.3337 13.95 10.31C13.89 10.26 13.81 10.28 13.74 10.29C13.65 10.31 12.25 11.24 9.52 13.08C9.12 13.35 8.76 13.49 8.44 13.48C8.08 13.47 7.4 13.28 6.89 13.11C6.26 12.91 5.77 12.8 5.81 12.45C5.83 12.27 6.08 12.09 6.55 11.9C9.47 10.63 11.41 9.79 12.38 9.39C15.16 8.23 15.73 8.03 16.11 8.03C16.19 8.03 16.38 8.05 16.5 8.15C16.6 8.23 16.63 8.34 16.64 8.42C16.63 8.48 16.65 8.66 16.64 8.8Z" />
  </svg>
);

export default function ProfileCard({
  avatarUrl,
  name,
  twitter,
  linkedin,
  telegram,
}) {
  return (
    <div className="pcard-wrapper">
      <div className="pcard">
        <div className="pcard-avatar">
          <img
            className="pcard-avatar-img"
            src={avatarUrl}
            alt={name || "Team member"}
            loading="lazy"
          />
        </div>
        {name && <div className="pcard-name">{name}</div>}
        <div className="pcard-socials">
          {twitter && (
            <a href={twitter} target="_blank" rel="noreferrer" className="pcard-social" title="Twitter / X">
              <TwitterIcon />
            </a>
          )}
          {linkedin && (
            <a href={linkedin} target="_blank" rel="noreferrer" className="pcard-social" title="LinkedIn">
              <LinkedInIcon />
            </a>
          )}
          {telegram && (
            <a href={telegram} target="_blank" rel="noreferrer" className="pcard-social" title="Telegram">
              <TelegramIcon />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
