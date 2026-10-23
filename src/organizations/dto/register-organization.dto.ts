import { IsEmail, IsNotEmpty, IsString, MinLength } from "class-validator";

export class SelfServiceRegistrationDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() ownerName: string;
  @IsEmail() ownerEmail: string;
  @IsString() @MinLength(6) password: string;
}
