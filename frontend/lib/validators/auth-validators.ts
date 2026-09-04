import z from "zod";

/**
 * Auth schemas. These drive both validation and the form UI: `FormBase` reads
 * `.isOptional()` for the required marker and the inputs read `minLength` /
 * `maxLength` off the schema, so keep the constraints here rather than as props.
 */

const email = z.string().min(1, "Email is required").email("Enter a valid email");

const password = z
  .string()
  .min(8, "At least 8 characters")
  .max(128, "At most 128 characters");

export const SignInSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(128),
});
export type TSignInSchema = z.infer<typeof SignInSchema>;

export const SignUpSchema = z
  .object({
    first_name: z.string().min(1, "First name is required").max(150),
    last_name: z.string().min(1, "Last name is required").max(150),
    email,
    password,
    re_password: z.string().min(1, "Confirm your password").max(128),
  })
  .refine((v) => v.password === v.re_password, {
    message: "The passwords do not match",
    path: ["re_password"],
  });
export type TSignUpSchema = z.infer<typeof SignUpSchema>;

export const ForgotPasswordSchema = z.object({ email });
export type TForgotPasswordSchema = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z
  .object({
    new_password: password,
    re_new_password: z.string().min(1, "Confirm your password").max(128),
  })
  .refine((v) => v.new_password === v.re_new_password, {
    message: "The passwords do not match",
    path: ["re_new_password"],
  });
export type TResetPasswordSchema = z.infer<typeof ResetPasswordSchema>;
