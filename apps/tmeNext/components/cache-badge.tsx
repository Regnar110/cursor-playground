import styles from "./cache-badge.module.css";

type Props = {
  label: string;
};

export function CacheBadge({ label }: Props) {
  return (
    <span className={styles.badge}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}
