import { Text, type StyleProp, type TextStyle } from "react-native";
import { brandName, brandText, brandTextOnDark } from "../theme/tokens";

type Props = {
  onDark?: boolean;
  style?: StyleProp<TextStyle>;
  size?: number;
};

/** Hero-level product name — always exactly "paper.irl". */
export function BrandMark({ onDark, style, size }: Props) {
  const base = onDark ? brandTextOnDark : brandText;
  return (
    <Text
      accessibilityRole="header"
      style={[base, size ? { fontSize: size } : null, style]}
    >
      {brandName}
    </Text>
  );
}
