import recommended from "@timmo001/oxlint-rules/configs/recommended-effect";

export default {
  extends: [recommended],
  ignorePatterns: ["dist/**", ".blume/**", ".blume-verify/**"],
  options: {
    typeAware: true,
    typeCheck: true,
    maxWarnings: 0,
  },
};
